// TODOs
// - block on chrome.storage (the flicker is too much) [but its like 50ms!]

// NOTES
// - when an extention is unloaded, there doesn't seem like a mechanism to detect it other than heartbeating

const EXTENSION = {
    origin: 'chrome-extension://' + chrome.runtime.id,    
};

const DEBUG = true;

// Monitor if extension context has been invalidated
let expirationInverval = setInterval(function() {
    if (!chrome.runtime.id) {
        console.log('extension context expired. we should do something...');
        clearInterval(expirationInverval);
    }
}, 5000);

const INIT = function() {
    const Util = {
        getUniqueID: function(prefix) {
            // Prefix_VersionYearMonthRandom
            const version = '1';
            const now = new Date();
            const year = (now.getFullYear() - 2019).toString(16); // TODO: 2035 is going to break
            const month = now.getMonth().toString(16);
            let buf = new Uint16Array(5);
            window.crypto.getRandomValues(buf);
            let str = '';
            for (let char of buf) {
                str += char.toString(16);
            }
            return `${prefix}_${version}${year}${month}${str}`;
        },
        hasClassName: function(element, className) {
            return (element.className || '').split(' ').includes(className);
        },
        addClassNameToElement: function(element, className) {
            if (!Util.hasClassName(element, className)) {
                element.className += element.className ? ` ${className}` : className;
            }
        },
        removeClassNameFromElement: function(element, className) {
            const elementClassName = element.className || '';
            element.className = elementClassName.split(' ').reduce(function(memo, current) {
                return current !== className ? `${memo} ${current}` : memo
            }, '' /* force .reduce to run on single elements */ );
        },
        exponentialValueIterator: function(start, factor, steps = 1, max = Infinity, fallback = void 0) {
            const cursor = { value: start, steps, factor };
            return function() {
                if (cursor.steps-- <= 0) {
                    return fallback;
                }
                cursor.value *= cursor.factor;
                const returnValue = Math.floor(cursor.value);
                return Math.min(returnValue, max);
            };
        },
        debounceAnimationFrame: function(fn) {
            let frame; // hold ref for previous request
            const self = this;
            return (...args) => {
                if (frame) { // clear previous if it's still defined
                    cancelAnimationFrame(frame);
                }
                frame = requestAnimationFrame(() => { // queue request
                    fn.apply(self, args);
                });
            };
        },
        debounceIdle: function(fn) {
            let id; // hold ref for previous request
            const self = this;
            return (...args) => {
                if (id) { // clear previous if it's still defined
                    cancelIdleCallback(id);
                    id = null;
                }
                id = requestIdleCallback(() => { // queue request
                    fn.apply(self, args);
                });
            };
        },
        setCookie: function({ name, value, tail }) {
            // Nothing to do for the case where we can't read or set cookies:
            // - In a text/plain document
            // - In an sandboxed iframe
            try {
                document.cookie = `${name}=${value}; ${tail}`;
            } catch (_) {}
        },
        getCookie: function(name) {
            let matches;
            try {
                matches = document.cookie.match(new RegExp(name + '=([^;]+)'));
            } catch (_) {}
            return matches ? matches[1] : null;
        },
        deleteCookie: function({ name, tail }) {
            try {
                document.cookie = `${name}=; Max-Age=0; ${tail}`;
            } catch (_) {}
        },
    };

    const AF_PAGE_ID = Util.getUniqueID('p');
    
    const StyleClass = {
        Iframe: 'airfolder-iframe',
        AttributeVisible: 'airfolder',
        AttributeCollapsed: 'collapsed',
        FixedElement: 'airfolder-fixed',
        WidthVariable: '--airfolder-width',
        LoadedAttribute: 'loaded',
        HoverExtended: 'hover-extended',
    };
    
    const Sidebar = new class {
        constructor() {
            const host = document.location.hostname; // ignores port since cookies don't support it
            const domain = host === 'localhost' ? null : host.startsWith('www.') ? host.slice(4) : host;
            this.cookieName = 'airfolder';
            this.cookieTail = `${domain ? `Domain=.${domain}; ` : ''}Path=/; SameSite=Strict; `;
            this.cookieMatchRegex = new RegExp(this.cookieName + '=([^;]+)');
            this.maxAge = 'Max-Age=315360000; ';
            // unlikely values to prevent false positives when checking for fixed position elements
            this.EXPANDED_WIDTH = 50;
            this.VIEW_STATES = {
                expanded: 'expanded',
                hidden: 'hidden',
            };
            this.VIEW_WIDTHS = {
                [this.VIEW_STATES.expanded]: this.EXPANDED_WIDTH,
                [this.VIEW_STATES.hidden]: 0,
            };
            this.settings = {
                view: this.VIEW_STATES.expanded,
                zoom: 1,
            };
            this.active = true;
            this.rootElement = null;
            this.iframeElement = null;
            this.seenByUser = false;            
        }
        getURL() {
            return chrome.runtime.getURL('sidebar.html');
        }
        storeRootElement(anchorElement) {
            this.rootElement = anchorElement;
        }
        storeIframeElement(iframeElement) {
            this.iframeElement = iframeElement;
        }
        persist(options) {
            // Persist locally for this domain
            Util.setCookie({
                name: this.cookieName,
                value: window.btoa(JSON.stringify(this.settings)),
                tail: `${this.cookieTail} ${this.maxAge}`,
            });

            // Propigate view state
            if (!options || options.notifySidebar !== false) {
                SidebarChannel.notify('set-view', { view: this.settings.view });
            }
            if (!options || options.notifyBackground !== false) {
                BackgroundChannel.notify('set-default-view', { view: this.settings.view });
            }
        }
        applySettings(overrideSettings) {
            if ('view' in overrideSettings) {
                Sidebar.setView(overrideSettings.view, {
                    notifyBackground: false,
                    notifySidebar: false,
                });
            }
            if ('zoom' in overrideSettings) {
                this.setZoom(overrideSettings.zoom);
            }
        }
        loadSettings() {
            // Load local domain specific values first (this is an performance optimization and saves ~50ms)
            let parsedSettings;
            const cookieValue = Util.getCookie(this.cookieName);
            if (cookieValue) {
                try {
                    parsedSettings = JSON.parse(window.atob(cookieValue));
                } catch (_) {
                    console.log('invalid cached settings. resetting...');
                }
            }
            if (parsedSettings) {
                this.applySettings(parsedSettings);
            } else {
                // Init and reset are both here
                Util.deleteCookie({ name: this.cookieName, tail: this.cookieTail });
            }
        }
        getView() {
            return this.settings.view;
        }
        setView(view, options) {
            if (!this.VIEW_STATES[view] || view === this.settings.view) return;

            // LOG.log('set view:', view);
            this.settings.view = view;

            // Close iframe shadow
            // this.closeShadow();

            // [CSS] Add visible attribute
            if (view === this.VIEW_STATES.hidden) {
                document.documentElement.removeAttribute(StyleClass.AttributeVisible);
            } else {
                document.documentElement.setAttribute(StyleClass.AttributeVisible, '');
            }           

            // Reflect change to width
            this.setWidth();

            // Persist
            this.persist(options);
        }
        getWidth() {
            const { zoom, view } = this.settings;
            return this.VIEW_WIDTHS[view] * zoom;
        }
        setWidth() {
            const width = this.getWidth();
            const widthPx = `${width}px`;

            // Apply style quickly before css rules take affect
            if (this.rootElement) {
                this.rootElement.style.left = `-${widthPx}`;
                window.requestAnimationFrame(() => { this.rootElement.style.removeProperty('left'); });
            }

            // Set :root style variable
            document.documentElement.style.setProperty('--airfolder-width', widthPx);

            // Set client window variable to reflect changes in events
            const windowScript = document.createElement('script');
            windowScript.text = `window.__airfolder_width = ${width};`;
            document.documentElement.appendChild(windowScript);
            document.documentElement.removeChild(windowScript);

            // Issue resize event to page (in case it's listening to readjust)
            window.dispatchEvent(new Event('resize'));
        }
        getZoom() {
            return this.settings.zoom;
        }
        setZoom(zoom) {
            // NB: Zoom is monitored from background, so we're only a receiver 
            if (zoom === this.settings.zoom) return;

            // LOG.log('set zoom:', zoom);
            this.settings.zoom = zoom;
            
            // Reflect change to width
            this.setWidth();
            
            // Persist
            this.persist({
                notifyBackground: false,
                notifySidebar: false,
            });
        }
        setActive(active) {
            this.active = active;
            if (active) {
                FixedElementObserver.start();
            } else {
                FixedElementObserver.stop();
            }
        }
    };

    const FixedElementObserver = new class {        
        classes = new Set();
        elementObservers = new Map(); // Element -> MutationObserver
        observerOptions = { attributes: true, childList: false, subtree: false };
        intervalIter = Util.exponentialValueIterator(50, 1.5, 20, 500, 1000);
        cssUnitRegex = /([a-z]+|%)$/;
        cssValueOffset = `var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px)`;
        styleFixedElementDebounced = Util.debounceAnimationFrame(element => this.styleFixedElement(element));
        timer = null;
        stylesheetRef = null;

        storeStylesheet(sheet) {
            this.stylesheetRef = sheet;
        }
        start() {
            if (this.timer === null) {
                // LOG.log('starting fixed element monitor...');
                const check = () => {
                    this.findNewFixedElements();
                    this.checkKnownFixedElements();
                    this.timer = setTimeout(checkDebounced, this.intervalIter());
                };
                const checkDebounced = Util.debounceIdle(check);
                check();
                this.timer = setTimeout(checkDebounced, this.intervalIter());
            }
        }
        stop() {
            if (this.timer !== null) {
                // LOG.log('stopping fixed element monitor...');
                clearTimeout(this.timer);
                this.timer = null;
                for (let [element, observer] of this.elementObservers) {
                    observer.disconnect();
                    if (element.classList) {
                        element.classList.remove(StyleClass.FixedElement, ...this.classes);
                    }
                    this.elementObservers.delete(element);
                }
            }
        }
        checkKnownFixedElements() {
            for (let element of this.elementObservers.keys()) {
                this.styleFixedElement(element);
            }
        }
        findNewFixedElements() {
            if (document.body) {
                // TODO: Explore document.all
                // TODO: Is there some property that allows us to filter _some_ portion of non-fixed elements
                for (let element of document.body.getElementsByTagName('*')) {
                    const computedStyle = getComputedStyle(element, null);
                    if (computedStyle.getPropertyValue('position') === 'fixed') {
                        if (!this.elementObservers.has(element)) {
                            this.watchElement(element, computedStyle);
                        }
                    }
                }
            }
        }
        watchElement(element, computedStyle = null) {
            // LOG.log('monitoring fixed element:', element);
            this.styleFixedElement(element, computedStyle);
            const observer = this.attachObserver(element);
            this.elementObservers.set(element, observer);
        }
        styleFixedElement(element, computedStyle = null) {
            const { hasFixedPosition, leftPx } = this.getFixedPosition(element, computedStyle);
            if (!hasFixedPosition) {
                if (element.classList.contains(StyleClass.FixedElement)) {
                    // LOG.log('removing fixed classes:', element);
                    element.classList.remove(StyleClass.FixedElement, ...this.classes);
                }
            } else if (!element.classList.contains(StyleClass.FixedElement)) {
                if (leftPx !== null) {
                    const leftClass = this.getLeftClass(leftPx);
                    // LOG.log('adding left fixed class:', leftClass, element);
                    element.classList.add(StyleClass.FixedElement, leftClass);
                } else {
                    // LOG.log('adding fixed class:', element);
                    element.classList.add(StyleClass.FixedElement);
                }
            }
        }
        attachObserver(element) {
            const observer = new MutationObserver(() => this.styleFixedElementDebounced(element));
            observer.observe(element, this.observerOptions);
            return observer;
        }
        getFixedPosition(element, prevComputedStyle = null) {
            const computedStyle = prevComputedStyle || getComputedStyle(element, null);
            const leftPx = parseFloat(computedStyle.getPropertyValue('left')); // always returns as px
            return {
                hasFixedPosition: computedStyle.getPropertyValue('position') === 'fixed',
                leftPx: leftPx < Sidebar.getWidth() ? leftPx : null, // ignore unless less than sidebar
            };
        }
        getLeftClass(leftPx) {
            const className = `af_fixed_${leftPx}`.replace('.', '_');
            if (!this.classes.has(className)) {
                // Append class style to stylesheet
                const ruleValue = `calc(${leftPx}px + ${this.cssValueOffset})`;
                const rule = `:root[${StyleClass.AttributeVisible}] .${className} { left: ${ruleValue} !important; }`;
                this.stylesheetRef.insertRule(rule);
                this.classes.add(className);
            }
            return className;
        }
    }

    // html.class-name[class] is a specificity override for pages with !important */
    const AIRFOLDER_STYLES = `
        @font-face {
            font-family: 'af-cs';
            src: url(data:application/font-woff2;charset=utf-8;base64,d09GMgABAAAAAAMkAA4AAAAABxwAAALIAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP0ZGVE0cGh4GYACCZhEICoJkgkEBNgIkAxwLEAAEIAWDPgdPP3dlYmYGG/EFyK4KbGOV4J8QyFmyMhKVeR+XNnj+mfO9L0kxbT9SziQS5BOTMAM1RYRuZ5KoudDy3gABJTYbYIDlcPX/FzD5wLFxgPM8b5JYYPs4a/NDTxKFc2+UFVAAnA51hE4uE+8PCMCL1X0XQP+6w/MQwAUEAwVBsCJomWNAVRVpx4KmDCi3gTa0I58ZlwOTmvjSczb55FHPezE7h7sFDigNAqiSyGrrbiqS/Y3GfODCjoKGYOzvJ4/XAMXL+6Uj+OeQKhfmKEEFsYKoOYlyoDT+ZwQ06FVBvPkAYAPAAziAfNAI7hmIpbMJwaIKWlq0b7hqiLGoSW+y6ZapJ+jQkzX+9WfQyk87fRvPiq3inL6hsRvKe3R3U59IRa9zx9Zed6GzsTtwc3ePrjf1hWzSN/RExo2bNmxgrYjersTJjBEASkVMhFZ1frIg3Zlp/3KgavPCj1+iB6OeRg9E1xEgHW+m6XjtNPAc6523HcbWzklPd78Nf6UP1V+F73obecYVoL+M8DMz7S4RL/Vg95mLh/JaIUePBbluu+6brkL3hL3Mw8XuU26367T7cEbwzkk7l09h/F7YLp/p36ABvykaLy1EPQ+vljOA9QOsaCHgpWlOANu1izcEfgogXzsnC2AjiaU8o7nKRS8qojkQ/JEoFTwqGwI1khjAaAwxFmMh2HqMFX+JGCfjFWOuC3YEc8NoVzE32fmOvsXX/x1fqITnYY8EmWKlSbafSe9byxQnR7I9MpuyFCoZ3UUbK76VJUGaVIYxRho9RLSwKT6bIY4pdWJlNhOLDXsVMCyxT5oV0rp5j7SJae8E7EHsadXr5Cyy2xw54hjGmsAw2jhTTbCsU40zsWrRaGNMkcRkSpc1cedM6RLkyNqMdZ0MOZsFZjJbUDCvsYEoKKKiiiYWa1xyQXr8GFtOasJoYgWosRMWzuuzYMroBciOvTN/AgAA) format('woff2');
            font-weight: normal;
            font-style: normal;
        }
        :root[${StyleClass.AttributeVisible}] {
            ${StyleClass.WidthVariable}: ${Sidebar.EXPANDED_WIDTH}px;
            display: flex; /* collapse margins */
            flex-direction: column; /* correct spacing */
            transform: none !important; /* breaks fixed position otherwise */
            padding-top: 0 !important;
            margin: 0 !important;
        }
        :root > airfolder {
            position: fixed !important;
            top: 0 !important;
            height: 100% !important;
            min-height: 100vh;
            margin: 0 !important;
            padding: 0 !important;
            z-index: 2147483648 !important;
            opacity: .2;
            left: -20px;
            background-color: #FFF;
        }
        :root > airfolder > iframe.${StyleClass.Iframe} {
            position: fixed !important;
            top: 0 !important;
            width: var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px);
            max-width: none !important;
            height: 100vh !important;
            background-color: #fff;
            background:
                url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' viewBox='0 0 1892 337'%3E%3Cg fill='none'%3E%3Cg fill='%23C5C5C5'%3E%3Cpath d='M23.8 0C72.9 0 122 0 171 0 174.5 0 177.5 0.3 182.4 4.1 193.6 12.8 213.1 28.3 240.8 50.7L320.6 50.7C333.7 50.7 344.3 61.3 344.3 74.5L344.3 313C344.3 326.1 333.7 336.7 320.6 336.7L23.8 336.7C10.6 336.7 0 326.1 0 313L0 23.8C0 10.6 10.6 0 23.8 0ZM44.4 33.6C40.3 33.6 37 36.9 37 41L37 51.6C37 55.6 40.3 58.9 44.4 58.9L156.3 58.9C160.4 58.9 163.7 55.6 163.7 51.6L163.7 41C163.7 36.9 160.4 33.6 156.3 33.6L44.4 33.6Z'/%3E%3Cpath d='M638.8 318.5C640.8 327.8 635.9 333.1 627 333.1L615.3 333.1C607.2 333.1 602.4 329 600.8 321L591.1 266.4 530 266.4 520.3 321C519.1 329 513.8 333.1 506.2 333.1L496.1 333.1C487.2 333.1 482.7 327.8 484.3 318.5L535.3 62.4C536.9 54.3 542.1 50.2 549.8 50.2L572.5 50.2C580.1 50.2 585.4 54.3 587 62.4L638.8 318.5ZM536.1 234.5L585.4 234.5 560.7 97.9 536.1 234.5ZM709.5 319.7C709.5 328.2 704.7 333.1 696.2 333.1L684.9 333.1C676 333.1 671.5 328.2 671.5 319.7L671.5 63.6C671.5 55.1 676 50.2 684.9 50.2L696.2 50.2C704.7 50.2 709.5 55.1 709.5 63.6L709.5 319.7ZM900.8 317.7C903.6 326.6 899.1 333.1 889.4 333.1L878.1 333.1C870.4 333.1 865.6 329.8 863.2 322.2L827.6 217.1 794.4 217.1 794.4 319.7C794.4 328.2 789.6 333.1 781.1 333.1L769.8 333.1C760.9 333.1 756.4 328.2 756.4 319.7L756.4 63.6C756.4 55.1 760.9 50.2 769.8 50.2L827.2 50.2C870 50.2 895.9 68.4 895.9 110L895.9 157.3C895.9 185.6 883.8 203 862.8 211.5L900.8 317.7ZM794.4 83.8L794.4 184 825.6 184C846.6 184 857.9 175.5 857.9 150.4L857.9 117.3C857.9 92.3 846.6 83.8 825.6 83.8L794.4 83.8ZM952.1 333.1C943.2 333.1 938.8 328.2 938.8 319.7L938.8 63.6C938.8 55.1 943.2 50.2 952.1 50.2L1043.1 50.2C1052 50.2 1056.4 55.1 1056.4 63.6L1056.4 70.4C1056.4 79.3 1052 83.8 1043.1 83.8L976.8 83.8 976.8 174.7 1030.5 174.7C1039.4 174.7 1043.9 179.5 1043.9 188L1043.9 195.3C1043.9 203.8 1039.4 208.6 1030.5 208.6L976.8 208.6 976.8 319.7C976.8 328.2 971.9 333.1 963.4 333.1L952.1 333.1ZM1082.7 106.8C1082.7 64.8 1108.6 47 1151.4 47L1154.7 47C1197.5 47 1223.4 65.2 1223.4 106.8L1223.4 276.5C1223.4 318.1 1197.5 336.3 1154.7 336.3L1151.4 336.3C1108.6 336.3 1082.7 318.1 1082.7 276.5L1082.7 106.8ZM1120.7 269.2C1120.7 294.3 1132 302.8 1153 302.8 1174.1 302.8 1185.4 294.3 1185.4 269.2L1185.4 114.1C1185.4 89 1174.1 80.5 1153 80.5 1132 80.5 1120.7 89 1120.7 114.1L1120.7 269.2ZM1368.1 298.7C1377 298.7 1381.5 303.6 1381.5 312.1L1381.5 319.7C1381.5 328.2 1377 333.1 1368.1 333.1L1280.4 333.1C1271.5 333.1 1267.1 328.2 1267.1 319.7L1267.1 63.6C1267.1 55.1 1271.5 50.2 1280.4 50.2L1291.7 50.2C1300.2 50.2 1305.1 55.1 1305.1 63.6L1305.1 298.7 1368.1 298.7ZM1480.1 50.2C1523 50.2 1548.9 68.4 1548.9 110L1548.9 273.3C1548.9 314.9 1523 333.1 1480.1 333.1L1423.5 333.1C1414.6 333.1 1410.2 328.2 1410.2 319.7L1410.2 63.6C1410.2 55.1 1414.6 50.2 1423.5 50.2L1480.1 50.2ZM1510.9 117.3C1510.9 92.3 1499.5 83.8 1478.5 83.8L1448.2 83.8 1448.2 299.5 1478.5 299.5C1499.5 299.5 1510.9 291.1 1510.9 266L1510.9 117.3ZM1713 319.7C1713 328.2 1708.6 333.1 1699.7 333.1L1605.9 333.1C1597 333.1 1592.5 328.2 1592.5 319.7L1592.5 63.6C1592.5 55.1 1597 50.2 1605.9 50.2L1698.5 50.2C1707.3 50.2 1711.8 55.1 1711.8 63.6L1711.8 70.4C1711.8 79.3 1707.3 83.8 1698.5 83.8L1630.5 83.8 1630.5 172.7 1685.9 172.7C1694.8 172.7 1699.3 177.5 1699.3 186L1699.3 193.3C1699.3 201.8 1694.8 206.6 1685.9 206.6L1630.5 206.6 1630.5 299.5 1699.7 299.5C1708.6 299.5 1713 304 1713 312.9L1713 319.7ZM1890.9 317.7C1893.7 326.6 1889.3 333.1 1879.6 333.1L1868.3 333.1C1860.6 333.1 1855.7 329.8 1853.3 322.2L1817.7 217.1 1784.6 217.1 1784.6 319.7C1784.6 328.2 1779.7 333.1 1771.2 333.1L1759.9 333.1C1751 333.1 1746.6 328.2 1746.6 319.7L1746.6 63.6C1746.6 55.1 1751 50.2 1759.9 50.2L1817.3 50.2C1860.2 50.2 1886.1 68.4 1886.1 110L1886.1 157.3C1886.1 185.6 1873.9 203 1852.9 211.5L1890.9 317.7ZM1784.6 83.8L1784.6 184 1815.7 184C1836.7 184 1848 175.5 1848 150.4L1848 117.3C1848 92.3 1836.7 83.8 1815.7 83.8L1784.6 83.8Z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E%0A") center center no-repeat,
                linear-gradient(
                    to left,
                    #9e9e9e 0,
                    #fff 1px
                );
            border: none;
            display: block !important;
            left: calc(-1 * var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px));
            transition: width 0.3s, opacity 0.3s, left 0.3s;
        }        
        :root > airfolder[${StyleClass.LoadedAttribute}] {
            border-right: none;
        }
        :root > airfolder[${StyleClass.LoadedAttribute}] > iframe.${StyleClass.Iframe} {
            background-color: transparent;
            background-image: none;
        }
        :root[${StyleClass.AttributeVisible}] {
            width: calc(100vw - var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px)) !important;
            position: relative !important;
            left: var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px) !important;
        }
        :root[${StyleClass.AttributeVisible}] > body {
            min-height: 100vh !important;
            margin-top: 0 !important;
            background-attachment: local !important;
        }
        :root[${StyleClass.AttributeVisible}] > airfolder {
            width: calc(var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px) - 0); /* KEEP "- 0"! */
            border-right: 1px solid #ababab;
            opacity: 1;
            left: 0;
        }
        :root:not([${StyleClass.AttributeVisible}]) > airfolder:hover {
            left: 0;
            transition: opacity 200ms, left 100ms;
            opacity: 0.9;
            cursor: pointer;
            display: flex;
            text-align: center;
            box-shadow: 7px 0 16px #00000026;
            border-right: 1px solid #ababab;
            background-color: #fff;
        }
        :root:not([${StyleClass.AttributeVisible}]) > airfolder::after {
            content: '\\e90e';
            font-family: 'af-cs';
            color: #171717;
            width: 100%;
            font-size: 16px;
            margin-top: 30px;
        }
        :root[${StyleClass.AttributeVisible}] > airfolder > iframe.${StyleClass.Iframe} {
            left: 0;
            transition: opacity 0.3s, left 0.3s;
            pointer-events: auto;
        }
        :root[${StyleClass.AttributeVisible}] .${StyleClass.FixedElement} {
            max-width: calc(100vw - var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px));
        }
        :root[${StyleClass.AttributeVisible}] > airfolder > iframe.${StyleClass.Iframe}.${StyleClass.HoverExtended} {
            width: ${Sidebar.EXPANDED_WIDTH}px;
            transition: width 0s;
        }
    `;

    Sidebar.loadSettings();

    const injectSidebar = function() {
        // Compose initial properties to pass to iframe
        const location = document.location;
        const hashParams = '#' + encodeURIComponent(JSON.stringify({
            zoom: Sidebar.getZoom(),
            view: Sidebar.getView(),
            page_id: AF_PAGE_ID,
            title: document.title,
            url: location.href + location.hash,
        }));

        // Skip XML files (for now)
        if (document.contentType === 'application/xml') {
            return;
        }

        // Detect PDF files
        if (document.contentType === 'application/pdf') {
            // TODO: Don't do extra work on these pages (i.e., monitor fixed elements)
            // TODO: Get title and set top window
            document.write(`
            <body style="padding: 0; margin: 0;">
              <object type="application/pdf" data="${document.location.href}" style="border: none; width: 100%; height: 100vh;"></object>
            </body>
            `);

            window.stop();
        }

        // Body, anchor, iframe and toggle styles
        const styleElement = document.createElement('style');
        styleElement.innerHTML = AIRFOLDER_STYLES;

        // Create overrideable functions for the window to use instead
        // All this just to remove sidebar width offset.
        // (report bugs to support@airfolder.io)
        const INITIAL_WINDOW_WIDTH = window.innerWidth; // Store initial values (until document.body shows up)      

        // Root element
        const anchorElement = document.createElement('airfolder');

        // <iframe> element
        const iframeElement = document.createElement('iframe');
        iframeElement.className = StyleClass.Iframe;
        iframeElement.setAttribute('importance', 'high'); // priority hint
        iframeElement.addEventListener('load', () => {
            anchorElement.setAttribute(StyleClass.LoadedAttribute, '');
        });
        iframeElement.src = Sidebar.getURL() + hashParams;
        anchorElement.appendChild(styleElement);
        anchorElement.appendChild(iframeElement);

        // Default to visible
        document.documentElement.setAttribute(StyleClass.AttributeVisible, '');

        // Inject under <HTML>
        document.documentElement.appendChild(anchorElement);

        // Grab the sheet refrence
        FixedElementObserver.storeStylesheet(styleElement.sheet);

        // Use to speed up performance of closing the sidebar
        Sidebar.storeRootElement(anchorElement);
        Sidebar.storeIframeElement(iframeElement);   
    };
    injectSidebar();

    // Seen by user allows us to know if the sidebar has ever been visble
    // Means we can't change it's view going forward.
    Sidebar.seenByUser = (document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', () => {
        const visible = document.visibilityState === 'visible';
        Sidebar.seenByUser = Sidebar.seenByUser || visible; // Set to true if ever visible
        Sidebar.setActive(visible);
    });

    class AirfolderMessageChannel {
        name = null;
        port = null;
        queuedPostMessages = [];
        handlers = {};
        reconnectBackoffIter = null;
        connectClient = null;
        options = {};
        callbacks = {};
        recievedMessageIDs = {};

        _post = (message) => {
            if (this.port && message) {
                this.port.postMessage(message);
            } else {
                this.queuedPostMessages.push(message);
            }
        };
        _initConnection = () => {
            try {
                this.connectClient(this._callbackWithPort);
                if (this.options.heartbeat) {
                    this._setupHeartbeat();
                }
                // Execute queued messages
                let message;
                while (message = this.queuedPostMessages.pop()) {
                    this.port.postMessage(message);
                }
            } catch (error) {
                this.port = null;
                if (this.options.onConnectionError) {
                    this.options.onConnectionError();
                }
            }
        };

        _callbackWithPort = (port, bindMessageHandler = null) => {        
            this.port = port;
            if (!port) {            
                console.log('missing_connection_port')
            }
            if (bindMessageHandler) {
                bindMessageHandler(this._channelMessageListener);
            } else {
                this.port.onMessage.addListener((message) => {
                    if (message) {
                        this.reconnectBackoffIter = null;                    
                        this._channelMessageListener(message);
                    }
                });
                this.port.onDisconnect.addListener(() => {
                    this.port = null;
                    if (this.options.onDisconnect) {                    
                        this.options.onDisconnect();
                    }
                    window.location.reload();
                });
            }
        };

        _handleRequest = async(request) => {        
            const { id, method, params } = request;
            const response = {};
            try {
                if (!(method in this.handlers)) {                
                    console.log('unhandled_method ' + method)
                }
                response.result = await this.handlers[method](params);
            } catch (e) {
                response.error = {
                    code: e.code,
                    message: e.message,
                };
            }
            if (id) { // Notify?
                response.id = id;
                this._post(response);
            }
        };

        _handleResponse = (response) => {
            const { id, result, error } = response;        
            if (error) {
                console.log(`error from [${this.name}]:`, error);
            } else if (!(id in this.callbacks)) {
                console.log(`got response with id: ${id} without callback`);
            } else {
                const { callback, timerID } = this.callbacks[id];
                clearTimeout(timerID);            
                delete this.callbacks[id];
                callback(result, error);
            }
        };

        _channelMessageListener = (message) => {        
            // handle heartbeats
            if (message.heartbeat) {
                if (message.heartbeat === 'pong') {
                    this._ackHeartbeat();
                } else if (message.heartbeat === 'ping' && this.port) {
                    this.port.postMessage({ heartbeat: 'pong' });
                }
                return;
            }
            const { id, method, result, error } = message;
            if (id) {
                if (id in this.recievedMessageIDs) {                
                    console.log('duplicate_message' + id)
                } else {
                    this.recievedMessageIDs[id] = 1;
                }
            }
            if (method) {
                this._handleRequest(message);
            } else if (id && (result || error)) {
                this._handleResponse(message);
            }
        };

        connect(name, connectClient, options = {}) {    
            this.name = name;
            this.options = options;
            this.connectClient = connectClient;
            this._initConnection();
        }

        notify(method, params) {        
            const message = { method };
            if (params) {
                message.params = params;
            }
            this._post(message);
        }
        on(method, handler) {        
            if (typeof handler !== 'function') {            
                return;
            }
            if (method in this.handlers) {     
                return;
            }
            this.handlers[method] = handler;
        }
    }
    
    // Setup background channel
    const BackgroundChannel = new AirfolderMessageChannel();

    // Update width of sidebar to reflect zoom changes
    BackgroundChannel.on('set-zoom', ({ zoom: zoomFactor }) => {
        Sidebar.setZoom(zoomFactor);
    });

    // Update sidebar view state
    BackgroundChannel.on('set-view', ({ view }) => {
        // Don't send value back to either sidebar or bg
        Sidebar.setView(view, {
            notifySidebar: false,
            notifyBackground: false,
        });
    });

    BackgroundChannel.on('init', ({ active, view }) => {
        Sidebar.setActive(active);
        Sidebar.setView(view, {
            notifySidebar: false,
            notifyBackground: false,
        });
    });

    // Connect
    BackgroundChannel.connect('background', callbackWithPort => {
        const port = chrome.runtime.connect({ name: `AF_CS/${AF_PAGE_ID}` });
        callbackWithPort(port);
    }, { autoReconnect: true });

    // Setup sidebar channel
    const SidebarChannel = new AirfolderMessageChannel();

    // Update sidebar view state
    SidebarChannel.on('set-view', ({ view }) => {
        // Don't send value back to either
        Sidebar.setView(view, {
            notifySidebar: false,
            notifyBackground: false,
        });
    });

    // Connect to sidebar
    // NB: Uses MessageChannel instead of chrome.tabs.connect to handle the case
    //     where the extension is unloaded and we lose access since the chrome API shuts down.
    window.addEventListener('message', function(e) {
        if (e.origin === EXTENSION.origin && e.data === `AF_SB/${AF_PAGE_ID}` && e.ports.length) {
            SidebarChannel.connect('sidebar', callbackWithPort => {
                const port = e.ports[0];
                callbackWithPort(port, bindMessageHandler => {
                    port.onmessage = event => bindMessageHandler(event.data);
                });
            });
        }
    }, false);

    // Setup full screen events (sidebar can't be open during fullscreen)
    const monitorFullscreenChange = function() {
        let previousViewState = null;
        document.addEventListener('fullscreenchange', function(e) {
            const isFullScreen = window.screenTop === 0;
            if (isFullScreen) {
                previousViewState = Sidebar.getView();
                if (previousViewState !== Sidebar.VIEW_STATES.hidden) {
                    // LOG.log('fullscreen:start - hiding sidebar');
                    Sidebar.setView(Sidebar.VIEW_STATES.hidden, {
                        notifyBackground: false,
                        notifySidebar: false,
                    });
                }
            } else if (previousViewState && previousViewState !== Sidebar.VIEW_STATES.hidden) {
                // LOG.log('fullscreen:end - restoring sidebar');
                Sidebar.setView(previousViewState, {
                    notifyBackground: false,
                    notifySidebar: false,
                });
                previousViewState = null;
            }
        });
    };
    monitorFullscreenChange();

    // TODO: Replace media queries in place
    // https://stackoverflow.com/questions/15696124/accessing-css-media-query-rules-via-javascript-dom
};

// Prevent recursive loading
if (!location.ancestorOrigins.contains(EXTENSION.origin) && window.top === window) {
    try {
        INIT();
    } catch (error) {
        console.log('error:', error);
    }
}

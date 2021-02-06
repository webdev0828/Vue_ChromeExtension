// Extension origin url
const EXTENSION = {
    origin: 'chrome-extension://' + chrome.runtime.id,
};

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
            // Get unique Id such as Prefix_VersionYearMonthRandom
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
            // Check if element has specific classname            
            return (element.className || '').split(' ').includes(className);
        },        
        addClassNameToElement: function(element, className) {
            // Add specific classname to element            
            if (!Util.hasClassName(element, className)) {
                element.className += element.className ? ` ${className}` : className;
            }
        },
        removeClassNameFromElement: function(element, className) {   // unused
            // Remove specific classname on element
            const elementClassName = element.className || '';
            element.className = elementClassName.split(' ').reduce(function(memo, current) {
                return current !== className ? `${memo} ${current}` : memo
            }, '' /* force .reduce to run on single elements */ );
        },
        exponentialValueIterator: function(start, factor, steps = 1, max = Infinity, fallback = void 0) {
            // Get exponential interator Value
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
            // Get the cookie with name
            let matches;
            try {
                matches = document.cookie.match(new RegExp(name + '=([^;]+)'));
            } catch (_) {}
            return matches ? matches[1] : null;
        },
        deleteCookie: function({ name, tail }) {
            // Delete cookie with name and tail
            try {
                document.cookie = `${name}=; Max-Age=0; ${tail}`;
            } catch (_) {}
        },
    };

    // Get Page ID
    const AF_PAGE_ID = Util.getUniqueID('p');
    
    // Style Classnames
    const StyleClass = {
        Iframe: 'airfolder-iframe',
        AttributeVisible: 'airfolder',
        FixedElement: 'airfolder-fixed',
        WidthVariable: '--airfolder-width',
        LoadedAttribute: 'loaded'
    };

    // Sidebar Class for managing everything on Sidebar
    const Sidebar = new class {
        constructor() {
            const host = document.location.hostname; // ignores port since cookies don't support it
            const domain = host === 'localhost' ? null : host.startsWith('www.') ? host.slice(4) : host;
            this.cookieName = 'airfolder';
            this.cookieTail = `${domain ? `Domain=.${domain}; ` : ''}Path=/; SameSite=Strict; `;
            this.cookieMatchRegex = new RegExp(this.cookieName + '=([^;]+)');
            this.maxAge = 'Max-Age=315360000; ';
            // unlikely values to prevent false positives when checking for fixed position elements
            this.EXPANDED_WIDTH = 50;    // Sidebar Width
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
            this.sidebarElement = null;
            this.seenByUser = false;            
        }
        storeRootElement(anchorElement) {
            // Store root element
            this.rootElement = anchorElement;
        }
        storeSidebarElement(sidebarElement) {
            // Store sidebar element
            this.sidebarElement = sidebarElement;
        }
        persist(options) {
            // Persist locally for this domain
            console.log('PersistSettings:', this.settings)
            Util.setCookie({
                name: this.cookieName,
                value: window.btoa(JSON.stringify(this.settings)),
                tail: `${this.cookieTail} ${this.maxAge}`,
            });

            // let parsedSettings;
            // const cookieValue = Util.getCookie(this.cookieName);

            // console.log('cookieValue', cookieValue)
            // if (cookieValue) {
            //     try {
            //         parsedSettings = JSON.parse(window.atob(cookieValue));
            //     } catch (_) {
            //         console.log('invalid cached settings. resetting...');
            //     }
            // }
            
            // console.log('PersistParsed:', parsedSettings)

            if (!options || options.notifyBackground !== false) {
                BackgroundChannel.notify('set-default-view', { view: this.settings.view });
            }
        }
        applySettings(overrideSettings) {
            // Apply view & zoom settings
            if ('view' in overrideSettings) {
                Sidebar.setView(overrideSettings.view, {
                    notifyBackground: false
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
            console.log('cookievalue', cookieValue)
            if (cookieValue) {
                try {
                    parsedSettings = JSON.parse(window.atob(cookieValue));
                } catch (_) {
                    console.log('invalid cached settings. resetting...');
                }
            }
            console.log(parsedSettings)
            if (parsedSettings) {
                this.applySettings(parsedSettings);
            } else {
                // Init and reset are both here
                Util.deleteCookie({ name: this.cookieName, tail: this.cookieTail });
            }
        }
        getView() {
            // Get current view mode
            return this.settings.view;
        }
        setView(view, options) {            
            if (!this.VIEW_STATES[view] || view === this.settings.view) return;

            console.log(view)
            
            this.settings.view = view;

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

            // Issue resize event to page (in case it's listening to readjust)
            window.dispatchEvent(new Event('resize'));
        }
        getZoom() {
            return this.settings.zoom;
        }        
        setZoom(zoom) {
            // Zoom is monitored from background, so we're only a receiver 
            if (zoom === this.settings.zoom) return;

            this.settings.zoom = zoom;
            
            // Reflect change to width
            this.setWidth();
            
            // Persist
            this.persist({
                notifyBackground: false
            });
        }

        // Update fixed element monitor state
        setActive(active) {
            this.active = active;
            if (active) {
                FixedElementObserver.start();
            } else {
                FixedElementObserver.stop();
            }
        }
    };

    // Fixed Element for managing all fixed elements on page
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
            // starting fixed element monitor
            if (this.timer === null) {
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
            // Stopping fixed element monitor
            if (this.timer !== null) {                
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
        
        // Check if there is some property that allows us to filter _some_ portion of non-fixed elements
        findNewFixedElements() {
            if (document.body) {                
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
        
        // Check fixed element
        watchElement(element, computedStyle = null) {           
            this.styleFixedElement(element, computedStyle);
            const observer = this.attachObserver(element);
            this.elementObservers.set(element, observer);
        }

        // Update specific classname to fixed element
        styleFixedElement(element, computedStyle = null) {               
            const { hasFixedPosition, leftPx, rightPx } = this.getFixedPosition(element, computedStyle);
            if (!hasFixedPosition) {
                if (element.classList.contains(StyleClass.FixedElement)) {                    
                    element.classList.remove(StyleClass.FixedElement, ...this.classes);
                }
            } else if (!element.classList.contains(StyleClass.FixedElement)) {                
                if (leftPx !== null) {                    
                    if(rightPx >= leftPx) {
                        const leftClass = this.getLeftClass(leftPx);
                        element.classList.add(StyleClass.FixedElement, leftClass);
                    }
                    if(rightPx < 0 && rightPx >= - 50) {
                        element.classList.add(StyleClass.FixedElement);
                    }
                } else {                    
                    const hasMaxWidth = this.getMaxWidth(element, computedStyle);                    
                    if(!hasMaxWidth)  {
                        element.classList.add(StyleClass.FixedElement);
                    }       
                }
            }
        }

        attachObserver(element) {
            const observer = new MutationObserver(() => this.styleFixedElementDebounced(element));
            observer.observe(element, this.observerOptions);
            return observer;
        }

        // Get Fixed Position to manage fixed components
        getFixedPosition(element, prevComputedStyle = null) {
            const computedStyle = prevComputedStyle || getComputedStyle(element, null);
            const leftPx = parseFloat(computedStyle.getPropertyValue('left')); // always returns as px
            const rightPx = parseFloat(computedStyle.getPropertyValue('right')); // always returns as px            

            if(Util.hasClassName(element, 'not_fixed')) {
                return {
                    hasFixedPosition: computedStyle.getPropertyValue('position') === 'fixed',
                    leftPx: leftPx < Sidebar.getWidth() ? leftPx : null, // ignore unless less than sidebar
                    rightPx: rightPx
                };
            } else {
                return {
                    hasFixedPosition: computedStyle.getPropertyValue('position') === 'fixed',
                    leftPx: leftPx,
                    rightPx: rightPx            
                };
            }
            
        }

        getMaxWidth(element, prevComputedStyle = null) {
            const computedStyle = prevComputedStyle || getComputedStyle(element, null);
            const maxWidth = parseFloat(computedStyle.getPropertyValue('max-width')); // always returns as px
            return maxWidth;
        }

        // Get left classname
        getLeftClass(leftPx, rightPx) {
            const className = `af_fixed_${leftPx}`.replace('.', '_');
            if (!this.classes.has(className) && leftPx !== 50 && rightPx !== 0) {
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
            /* display: flex; collapse margins */
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
        :root > airfolder > .${StyleClass.Iframe} {
            position: fixed !important;
            top: 0 !important;
            width: var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px);
            max-width: none !important;
            height: 100vh !important;
            background-color: #fff;            
            border: none;
            display: block !important;
            left: calc(-1 * var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px));
            transition: width 0.3s, opacity 0.3s, left 0.3s;
        }        
        :root > airfolder[${StyleClass.LoadedAttribute}] {
            border-right: none;
        }
        :root > airfolder[${StyleClass.LoadedAttribute}] > .${StyleClass.Iframe} {
            background-color: transparent;
            background-image: none;
        }
        :root[${StyleClass.AttributeVisible}] {
            width: calc(100% - var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px)) !important;
            min-width: calc(100% - var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px)) !important;
            position: relative !important;
            left: var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px) !important;
        }
        :root[${StyleClass.AttributeVisible}] > body {
            min-height: 100vh !important;
            margin-top: 0 !important;
            background-attachment: local !important;
            overflow-y: auto;
        }
        :root[${StyleClass.AttributeVisible}] > airfolder {
            width: calc(var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px) - 0); /* KEEP "- 0"! */            
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
        :root[${StyleClass.AttributeVisible}] > airfolder > .${StyleClass.Iframe} {
            left: 0;
            transition: opacity 0.3s, left 0.3s;
            pointer-events: auto;
        }
        :root[${StyleClass.AttributeVisible}] .${StyleClass.FixedElement} {
            max-width: calc(100% - var(${StyleClass.WidthVariable}, ${Sidebar.EXPANDED_WIDTH}px))!important;
        }
    `;

    // Load Sidebar Settings
    Sidebar.loadSettings();

    const injectSidebar = function() {
        // Body, anchor, Sidebar and toggle styles
        const styleElement = document.createElement('style');
        styleElement.innerHTML = AIRFOLDER_STYLES;

        // Create overrideable functions for the window to use instead
        // All this just to remove sidebar width offset.
        // (report bugs to support@airfolder.io)
        const INITIAL_WINDOW_WIDTH = window.innerWidth; // Store initial values (until document.body shows up)
        const windowFunctionsScript = document.createElement('script');
        windowFunctionsScript.text = `(function() {
            window.__airfolder_width = ${Sidebar.getWidth()};
            const windowWidth = function() {
                const offset = window.__airfolder_width || 0;
                const d = window.document;
                return d.body ? d.body.clientWidth : ${INITIAL_WINDOW_WIDTH} - offset;
            };
            window.__defineGetter__('innerWidth', windowWidth);
            window.__defineGetter__('outerWidth', windowWidth);
            window.document.documentElement.__defineGetter__('clientWidth', windowWidth);
            window.document.documentElement.__defineGetter__('scrollWidth', windowWidth);
            const wrapMouseEvent = function(mouseEvent) { // should be called with 'this'?
                return new Proxy(mouseEvent, {
                    get(target, prop, receiver) {
                        if (prop === 'isTrusted') { // Can't mess with isTrusted
                            return target[prop];
                        }
                        const descriptor = Object.getOwnPropertyDescriptor(receiver, prop); // Bind proxy
                        const value = descriptor?.get?.call(receiver) || target[prop];
                        if (typeof value === 'function') {
                            return (...args) => value.apply(target, args);
                        }
                        if (prop === 'pageX' || prop === 'screenX' || prop === 'clientX') {
                            return value - (window.__airfolder_width || 0);
                        }
                        return value;
                    },
                    set(target, prop, value) {
                        target[prop] = value;
                        return true;
                    },
                    getPrototypeOf: (target) => target.constructor.prototype,
                });
            };
            const eventTypeFilter = new Set([
                'mouseup', 'mousedown', 'mousemove', 'click', 'dblclick', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'contextmenu',
                'lostpointercapture', 'pointerover', 'pointerenter', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerout', 'pointerleave',
                // 'drag', 'dragend', 'dragenter', 'dragexit', 'dragleave', 'dragover', 'dragstart', 'drop',
                // 'touchstart', 'touchend', 'touchmove', 'touchcancel'
                // gestures
            ]);
            const listenerMap = new class {
                root = new WeakMap();
                set(compositeKey, value) {
                    let map = this.root;
                    let lastKey = compositeKey.pop();
                    for (let key of compositeKey) {
                        let next = map.get(key);
                        if (!next) {
                            next = new Map();
                            map.set(key, next);
                        }
                        map = next;
                    }
                    map.set(lastKey, value);
                }
                get(compositeKey) {
                    let next = this.root;
                    for (let key of compositeKey) {
                        if (!next.has(key)) {
                            return undefined;
                        }
                        next = next.get(key);
                    }
                    return next;
                }
                delete(compositeKey) {
                    let next = this.root;
                    const deletePairs = [];
                    for (let key of compositeKey) {
                        if (!next.has(key)) {
                            return false;
                        }
                        deletePairs.unshift([next, key]);
                        next = next.get(key);
                    }
                    for (let [map, key] of deletePairs) {
                        map.delete(key);
                        if (map.size) {
                            break;
                        }
                    }
                    return true;
                }
            };
            const wrapListener = function(thisArg, listener) {
                const wrappedListener = (event, ...args) => {
                    if (typeof listener !== 'undefined') {
                        if (event instanceof MouseEvent) {
                            const wrappedEvent = wrapMouseEvent(event);
                            if (listener.handleEvent) {
                                listener.handleEvent.call(listener, wrappedEvent, ...args);    
                            } else {
                                listener.call(thisArg, wrappedEvent, ...args);
                            }
                        } else {
                            listener.call(thisArg, event, ...args);
                        }
                    }
                };
                if (listener.handleEvent) {
                    return {
                        handleEvent: wrappedListener,
                    };
                }
                return wrappedListener;
            };
            EventTarget.prototype.addEventListener = new Proxy(EventTarget.prototype.addEventListener, {
                apply: function(target, thisArg, [type, listener, opt]) {
                    if (!type || !listener || typeof type !== 'string') {
                        return target.apply(thisArg, [type, listener, opt]);
                    }
                    const typeLowerCase = type.toLowerCase();
                    if (!eventTypeFilter.has(typeLowerCase)) {
                        return target.apply(thisArg, [type, listener, opt]);
                    }
                    const thisArgSafe = thisArg || window;
                    const capture = typeof opt === 'object' && opt !== null ? 'capture' in opt ? !!opt.capture : false : !!opt;
                    const compositeKey = [thisArgSafe, typeLowerCase, listener, capture];
                    const wrappedListener = listenerMap.get(compositeKey) || wrapListener(thisArg, listener);
                    listenerMap.set(compositeKey, wrappedListener);
                    return target.apply(thisArg, [type, wrappedListener, opt]);
                }
            });
            EventTarget.prototype.removeEventListener = new Proxy(EventTarget.prototype.removeEventListener, {
                apply: function(target, thisArg, [type, listener, opt]) {
                    if (!type || typeof type !== 'string') {
                        return target.apply(thisArg, [type, listener, opt]);
                    }
                    const typeLowerCase = type.toLowerCase();
                    if (!eventTypeFilter.has(typeLowerCase)) {
                        return target.apply(thisArg, [type, listener, opt]);
                    }
                    const thisArgSafe = thisArg || window;
                    const capture = typeof opt === 'object' && opt !== null ? 'capture' in opt ? !!opt.capture : false : !!opt;
                    const compositeKey = [thisArgSafe, typeLowerCase, listener, capture];
                    const wrappedListener = listenerMap.get(compositeKey);
                    if (wrappedListener) {
                        listenerMap.delete(compositeKey);
                        return target.apply(thisArg, [type, wrappedListener, opt]);
                    } else {
                        return target.apply(thisArg, [type, listener, opt]);
                    }
                }
            });
            const origGetClientRects = Element.prototype.getClientRects;
            Element.prototype.getClientRects = function() {
                const offset = window.__airfolder_width || 0;
                const domRectList = [];
                for (let r of origGetClientRects.call(this)) {
                    domRectList.push(new DOMRect(r.x - offset, r.y, r.width, r.height));
                }
                domRectList.item = function(x) { return this[x]; };
                domRectList.__proto__ = DOMRectList.prototype;
                return domRectList;
            };
            const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
            Element.prototype.getBoundingClientRect = function() {
                const rect = origGetBoundingClientRect.call(this);
                const offset = window.__airfolder_width || 0;
                return new DOMRect(rect.x - offset, rect.y, rect.width, rect.height);
            };
        })();`;

        // Root element
        const anchorElement = document.createElement('airfolder');

        // <Sidebar> element
        const sidebarElement = document.createElement('div');
        sidebarElement.setAttribute('id', 'airfolder_sidebar')
        sidebarElement.className = StyleClass.Iframe;
        sidebarElement.setAttribute('importance', 'high'); // priority hint
        sidebarElement.addEventListener('load', () => {
            anchorElement.setAttribute(StyleClass.LoadedAttribute, '');
        });
        anchorElement.appendChild(styleElement);
        anchorElement.appendChild(sidebarElement);

        // Default to visible
        document.documentElement.setAttribute(StyleClass.AttributeVisible, '');

        // Inject under <HTML>
        document.documentElement.appendChild(anchorElement);

        // Grab the sheet refrence
        FixedElementObserver.storeStylesheet(styleElement.sheet);

        // Use to speed up performance of closing the sidebar
        Sidebar.storeRootElement(anchorElement);
        Sidebar.storeSidebarElement(sidebarElement);

         // Add and remove <script> after it runs
        // anchorElement.appendChild(windowFunctionsScript);
        // anchorElement.removeChild(windowFunctionsScript);
    };

    const setAbsoluteClass = () => {
        const elements = document.getElementsByTagName('*')
        for (let element of elements) {
            const computedStyle = getComputedStyle(element, null);
            if (computedStyle.getPropertyValue('position') !== 'fixed') {
                if(element.className && typeof(element.className) === 'string' && !element.className.includes('not_fixed')) 
                    Util.addClassNameToElement(element, 'not_fixed')
            }
        }
    }

    // Inject Sidebar on page
    injectSidebar();

    document.onreadystatechange = () => {
        if (document.readyState === 'complete') {
            setAbsoluteClass();
        }
    };

    // Seen by user allows us to know if the sidebar has ever been visble
    // Means we can't change it's view going forward.
    Sidebar.seenByUser = (document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', () => {
        const visible = document.visibilityState === 'visible';
        Sidebar.seenByUser = Sidebar.seenByUser || visible; // Set to true if ever visible
        Sidebar.setActive(visible);
    });

    // Setup Background channel
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

        // Post message or queue postmessage
        _post = (message) => {
            if (this.port && message) {
                this.port.postMessage(message);
            } else {
                this.queuedPostMessages.push(message);
            }
        };
        // Init Connection
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
                console.log(error)
                this.port = null;
                if (this.options.onConnectionError) {
                    this.options.onConnectionError();
                }
            }
        };

        // Callback function
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

        // Handle request from messageListener
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

        // Handle response from messageListener
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

        // MessageListener Channel
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

        // Init connection function with parameters
        connect(name, connectClient, options = {}) {    
            this.name = name;
            this.options = options;
            this.connectClient = connectClient;
            this._initConnection();
        }

        // Notify function
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
            notifyBackground: false,
        });
    });

    // Init sidebar view state
    BackgroundChannel.on('init', ({ active }) => {
        Sidebar.setActive(active);
    });

    // Connect to background
    BackgroundChannel.connect('background', callbackWithPort => {
        const port = chrome.runtime.connect({ name: `AF_CS/${AF_PAGE_ID}` });
        callbackWithPort(port);
    }, { autoReconnect: true });

    // Setup full screen events (sidebar can't be open during fullscreen)
    const monitorFullscreenChange = function() {
        let previousViewState = null;
        document.addEventListener('fullscreenchange', function(e) {      // Add listener for full-screen
            const isFullScreen = window.screenTop === 0;
            if (isFullScreen) {
                previousViewState = Sidebar.getView();
                if (previousViewState !== Sidebar.VIEW_STATES.hidden) {
                    Sidebar.setView(Sidebar.VIEW_STATES.hidden, {
                        notifyBackground: false
                    });
                }
            } else if (previousViewState && previousViewState !== Sidebar.VIEW_STATES.hidden) {
                Sidebar.setView(previousViewState, {
                    notifyBackground: false
                });
                previousViewState = null;
            }
        });
    };
    monitorFullscreenChange(); // monitor if the screen converts to fullscreen

    new Vue({
        el: '#airfolder_sidebar',         // find the element with id
        render(e) {
            return e('div', {
                attrs: { id: 'airfolder_sidebar', class: 'airfolder-iframe', style: 'background: green' },
                on: {
                    click: function() {     // Action when click on Sidebar
                        const view = Sidebar.VIEW_STATES.hidden;        // Hide left-sidebar
                        Sidebar.setView(view);         // Call setView function to inform view mode to contentscript & backgroundscript
                    }                
                }
            });
        }
    });
};

// Prevent recursive loading
if (!location.ancestorOrigins.contains(EXTENSION.origin) && window.top === window) {
    try {
        INIT(); // init
    } catch (error) {
        console.log('error:', error);
    }
}

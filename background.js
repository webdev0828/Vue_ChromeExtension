(async() => {

    const PREFERENCE_KEYS = {
        DefaultSidebarView: 'sidebar-view',
        ZoomFactor: 'zoom-factor', // TODO: Remove since zoom should match current values        
    };
    
    const SIDEBAR_VIEW_STATES = {
        expanded: 'expanded',
        hidden: 'hidden',
    };

    const PREFERENCE_LIST = {
        [PREFERENCE_KEYS.DefaultSidebarView]: {
            default: SIDEBAR_VIEW_STATES.expanded,
            validate: (v) => v in SIDEBAR_VIEW_STATES,
            encode: (v) => v,
            decode: (v) => v,
        },
        [PREFERENCE_KEYS.ZoomFactor]: { // TODO: Remove since zoom should match current values
            default: 1,
            validate: (z) => Number.isFinite(z) && z >= 0 && z <= 1,
            encode: (z) => z,
            decode: (z) => parseFloat(z),
        },
    };

    const DEFAULT_AF = { // Initial data        
        PREFERENCES: {
            version: '0.1',            
            values: Object.values(PREFERENCE_KEYS).reduce((memo, value) => ({
                [value]: PREFERENCE_LIST[value].default,
                ...memo,
            }), {}),
        },       
    };

    const AF = JSON.parse(JSON.stringify(DEFAULT_AF));

    class AFTab {
        id = null; // unique browser id for tab
        windowID = null; // tab's windowId (used to bring focus on switch)
        pageID = null; // unique random page session ID (shared between contentscript and sidebar)        
        url = null;
        title = null;
        icon = null;
        contentscript = null; // chrome.runtime message channel with contentscript
    }

    const AF_TABS = new class {
        tabs = new Map();       // [TabID] --> AFTab
        activeTabIDs = new Set(); // [TabID] --> AFTab

        find(tabID) {
            return this.tabs.get(tabID);
        }        
        store(tab, pageID) {
            const tabID = tab.id;

            // Check if tabID is already stored
            if (this.tabs.has(tabID)) {                
                this.remove(tabID);
            }

            // Create new tab if not 
            const afTab = new AFTab();
            afTab.id = tabID;
            afTab.windowID = tab.windowId;
            afTab.pageID = pageID;
            afTab.url = tab.url;
            afTab.origin = new URL(tab.url).origin;
            afTab.title = tab.title;
            afTab.updateTime = new Date().getTime(); // used to track latest
            afTab.seenByUser = tab.active;

            // Add to index
            this.tabs.set(tabID, afTab);

            // Set active
            if (tab.active) {
                this.activeTabIDs.add(tabID);
            }

            return afTab;
        }
        
        // remove tab from tabs array
        remove(tabID, notify = true) {
            const afTab = this.tabs.get(tabID);
            if (!afTab) {                
                return;
            }
            this.tabs.delete(tabID);        
        }

        setActiveTabs(tabs) {
            const inactiveTabIDs = new Set(this.activeTabIDs);
            for (let { id: tabID } of tabs) {
                inactiveTabIDs.delete(tabID);
                // New active tabs
                if (!this.activeTabIDs.has(tabID)) {
                    this.activeTabIDs.add(tabID);
                }
                // Set flag on tab that it has been seen by a user
                const afTab = AF_TABS.tabs.get(tabID);
                if (afTab) {
                    afTab.seenByUser = true;
                }
            }
            // Remove inactive tabs
            for (let tabID of inactiveTabIDs) {
                this.activeTabIDs.delete(tabID);
            }
        }
    };

    const setPreference = function(preference, value) {        
        AF.PREFERENCES.values[preference] = value;
    };

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
                    this._reconnect();
                });
            }
        };

        _reconnect = (force) => {
            if (force || this.options.autoReconnect) {
                const nextConnectInterval = this.reconnectBackoffIter();
                if (nextConnectInterval) {                
                    setTimeout(() => this._initConnection(), nextConnectInterval);
                }
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

        // Init variables and call connection
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

    const initializeContentscriptConnection = function(port, afTab) {
        const { contentscript, id: tabID } = afTab;

        // Connect to contentscript
        const name = `${tabID}:contentscript`;
        contentscript.connect(name, callbackWithPort => callbackWithPort(port), {
            onDisconnect: () => {
                // Might have already been disconnected
                if (AF_TABS.tabs.has(tabID)) {
                    AF_TABS.remove(tabID);
                }
            },
        });

        const result = {
            active: AF_TABS.activeTabIDs.has(tabID)
        };
        contentscript.notify('init', result);
    };

    const originZoomFactorMap = new Map(); // [origin] +--+ zoomFactor
    
    // Bind on zoom changes
    chrome.tabs.onZoomChange.addListener(function(zoomChangeInfo) {
        // For only tabs we care about
        const { tabId: tabID, newZoomFactor, zoomSettings } = zoomChangeInfo;
        const zoomFactor = 1 / newZoomFactor;
        const afTabZoomChange = AF_TABS.find(tabID);
        if (afTabZoomChange) {
            const scope = zoomSettings.scope;
            if (scope === 'per-origin') {
                const currentZoomFactor = originZoomFactorMap.get(afTabZoomChange.origin);
                if (typeof currentZoomFactor === 'undefined' || currentZoomFactor !== zoomFactor) {
                    originZoomFactorMap.set(afTabZoomChange.origin, zoomFactor);
                    // Let all sidebars and contentscripts with the same origin get new zoom factor
                    for (let afTab of AF_TABS.tabs.values()) {
                        if (afTab.origin === afTabZoomChange.origin && afTab.sidebar && afTab.contentscript) {
                            afTab.contentscript.notify('set-zoom', { zoom: zoomFactor });
                        }
                    }
                }
            } else if (scope === 'per-tab') {
                afTab.contentscript.notify('set-zoom', { zoom: zoomFactor });
            }
        }
    });

    // Setup both SidebarChannel and ContentScript channels
    chrome.runtime.onConnect.addListener(async function(port) {
        const { name, sender } = port;
        const { id: runtimeID, tab } = sender;
        const tabID = tab.id;
        if (runtimeID !== chrome.runtime.id) {
            return; // not our extension
        }

        // Init connections
        const [source, pageID] = name.split('/');
        if (source === 'AF_CS') {
            // Create new tab
            const afTab = AF_TABS.store(tab, pageID);
            afTab.contentscript = new AirfolderMessageChannel();
            initializeContentscriptConnection(port, afTab);
        }

        // Fetch current zoom factor
        chrome.tabs.getZoom(tabID, zoomFactor => {
            const afTab = AF_TABS.find(tabID);
            if (afTab && afTab.sidebar && afTab.contentscript) {
                const newZoomFactor = 1 / zoomFactor;
                originZoomFactorMap.set(afTab.origin, newZoomFactor);
                afTab.contentscript.notify('set-zoom', { zoom: newZoomFactor });
            }
        });
    });

    // Track the active tab
    const updateActiveTab = function() {
        chrome.tabs.query({ active: true }, function(tabs) {
            AF_TABS.setActiveTabs(tabs);
        });
    };
    chrome.tabs.onActivated.addListener(updateActiveTab);           // Add listener: updateActiveTab when tab is active
    chrome.windows.onFocusChanged.addListener(updateActiveTab);     // Add listener: updateActiveTab when activation is changed on window

    // Toggle Airfolder
    chrome.browserAction.onClicked.addListener(function() {
        // When click extension icon, set view into expanded
        const newView = SIDEBAR_VIEW_STATES.expanded;
        setPreference(PREFERENCE_KEYS.DefaultSidebarView, newView);        
        // Broadcast preference change to all nodes
        for (let afTab of AF_TABS.tabs.values()) {
            if (afTab.contentscript) {
                afTab.contentscript.notify('set-view', { view: newView });
            }
        }
    });
})();

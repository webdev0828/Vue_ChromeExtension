// Fetch initial page properties passed to us
const INIT = JSON.parse(decodeURIComponent(document.location.hash.slice(1)));
const DEBUG = false

// Placeholder for Vue components
const Views = {};

// Set background to white to hide iframe loading background
document.documentElement.classList.add('loaded');

if (DEBUG) {
    document.body.className += ' debug';
}

// MessageChannel Class for communicate with contentscript and backgroundscript
class AirfolderMessageChannel {
    name = null;     // page title
    port = null;     // page port
    queuedPostMessages = [];    // queued Messages
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
    // Init connection
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
    
    // Callback with Port
    _callbackWithPort = (port, bindMessageHandler = null) => {        
        this.port = port;
        if (!port) {            
            console.log('missing_connection_port')
        }
        if (bindMessageHandler) {
            bindMessageHandler(this._channelMessageListener);    // bind message handler with channelMessageListener
        } else {
            this.port.onMessage.addListener((message) => {       // Add listner for sending the message
                if (message) {
                    this.reconnectBackoffIter = null;                   
                    this._channelMessageListener(message);
                }
            });
            this.port.onDisconnect.addListener(() => {           // Add listner when port is disconnected
                this.port = null;
                if (this.options.onDisconnect) {
                    this.options.onDisconnect();
                }
                window.location.reload();
            });
        }
    };
    _handleRequest = async(request) => {                             // Handle Request
        const { id, method, params } = request;
        const response = {};
        try {
            if (!(method in this.handlers)) {
                console.log('unhandled_method ' + method)
            }
            response.result = await this.handlers[method](params);   // Call related handler
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

    _handleResponse = (response) => {                               // Handle response
        const { id, result, error } = response;        
        if (error) {
            console.log(`error from [${this.name}]:`, error);
        } else if (!(id in this.callbacks)) {
            console.log(`got response with id: ${id} without callback`);
        } else {
            const { callback, timerID } = this.callbacks[id];      // Get callback and timerId from Callbacks array
            clearTimeout(timerID);            
            delete this.callbacks[id];
            callback(result, error);
        }
    };

    _channelMessageListener = (message) => {                      // MessageListener Channel
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

    // Notify message
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

const Sidebar = new class {    // Sidebar Class for managing everything on sidebar
    VIEW_STATES = {
        expanded: 'expanded',
        hidden: 'hidden',
    };
    settings = {
        view: this.VIEW_STATES.expanded,
        zoom: 1,
    };
    connected = false;

    initComplete() {
        this.connected = true;
    };
    setView(view, options) {      // Set view mode
        if (!this.VIEW_STATES[view] || view === this.settings.view) return;        
        this.settings.view = view;

        // Send view mode to contentscript
        if (!options || options.notifyContentscript !== false) {
            ContentscriptChannel.notify('set-view', { view });
        }
        // Send view mode to background
        if (!options || options.notifyBackground !== false) {
            BackgroundChannel.notify('set-default-view', { view });
        }
    }
    setZoom(zoom) {       // Set zoom 
        this.settings.zoom = zoom;
        document.documentElement.style.zoom = zoom;
    }    
};

// Setup Background channel
const BackgroundChannel = new AirfolderMessageChannel();

// Update Sidebar to show as expanded
BackgroundChannel.on('set-view', ({ view }) => {
    Sidebar.setView(view, {
        notifyContentscript: true, // forward to contentscript in case contentscript is disconnected
        notifyBackground: false,
    });
});

// Update Sidebar to zoom
BackgroundChannel.on('set-zoom', ({ zoom }) => {
    Sidebar.setZoom(zoom);
});

// Connect with Background
BackgroundChannel.connect('background', callbackWithPort => {
    const port = chrome.runtime.connect({ name: `AF_SB/${INIT.page_id}` });
    callbackWithPort(port);
}, {
    autoReconnect: true,   
    onConnectionError: () => {
        document.location.reload();  // Reload if there is error in connection
    },
});

// Setup ContentScript channel
const ContentscriptChannel = new AirfolderMessageChannel();

// Connect with ContentScript
ContentscriptChannel.connect('contentscript', callbackWithPort => {
    const channel = new MessageChannel();
    const port = channel.port1;
    const portToPass = channel.port2;
    callbackWithPort(port, bindMessageHandler => {
        port.addEventListener('message', event => bindMessageHandler(event.data), false);
        port.start();
        window.parent.postMessage(`AF_SB/${INIT.page_id}`, '*', [portToPass]);
    });
}, { autoReconnect: true });

// Init view
Sidebar.setZoom(INIT.zoom);
Sidebar.setView(INIT.view, {
    notifyContentscript: false,
    notifyBackground: false,
});

// Sidebar Vue Component
Views.sidebar = new Vue({
    el: '#sidebar',         // find the element with id
    render(e) {
        return e('div', {
            attrs: { id: 'sidebar' },
            on: {
                click: function() {     // Action when click on Sidebar
                    const view = Sidebar.VIEW_STATES.hidden;        // Hide left-sidebar
                    Sidebar.setView(view);         // Call setView function to inform view mode to contentscript & backgroundscript
                }                
            }
        });
    }
});
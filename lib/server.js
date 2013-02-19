
var mqtt = require("mqtt");
var async = require("async");
var ascoltatori = require("ascoltatori");
var EventEmitter = require("events").EventEmitter;

/**
 * The Mosca Server is a very simple MQTT server that supports
 * only QoS 0.
 * It is backed by Ascoltatori, and it descends from
 * EventEmitter.
 *
 * Options:
 *  - `port`, the port where to create the server.
 *
 * Events:
 *  - `clientConnected`, when a client is connected;
 *    the client is passed as a parameter.
 *  - `clientDisconnected`, when a client is disconnected;
 *    the client is passed as a parameter.
 *  - `published`, when a new message is published;
 *    the packet and the client are passed as parameters.
 *
 * @param {Object} opts The option object
 * @param {Function} callback The ready callback
 * @api public
 */
function Server(opts, callback) {
  EventEmitter.call(this);

  this.opts = opts;
  opts.port = opts.port || 1883;

  this.ascoltatore = new ascoltatori.MemoryAscoltatore()

  this.clients = {};

  var that = this;
  this.server = mqtt.createServer(function(client) {
    that.serve(client);
  });
  this.server.listen(opts.port, callback);
}

module.exports = Server;

Server.prototype = Object.create(EventEmitter.prototype);

/**
 * Utility function to call a callback in the next tick
 * if it was there.
 *
 * @api private
 * @param {Function} callback
 */
function next(callback) {
  if(callback)
    process.nextTick(callback);
}

/**
 * Closes the server.
 *
 * @api public
 * @param {Function} callback The closed callback function
 */
Server.prototype.close = function(callback) {
  var that = this;

  async.parallel(Object.keys(that.clients).map(function(id) { 
    return function(cb) {
      that.closeConn(that.clients[id], cb);
    }
  }), function() {
    try {
      that.server.close(callback);
    } catch(exception) {
      callback();
    }
  });
};

/**
 * Serves a client coming from MQTT.
 *
 * @api private
 * @param {Object} client The MQTT client
 */
Server.prototype.serve = function (client) {

  var that = this;

  var setUpTimer = function() {
    if(client.timer)
      clearTimeout(client.timer);

    client.timer = setTimeout(function() {
      that.closeConn(client);
    }, client.keepalive * 1000 * 5/4);
  };

  var forward = function(topic, payload) {
    client.publish({ topic: topic, payload: payload });
  };

  client.on("connect", function(packet) {
    client.id = packet.client;
    client.keepalive = packet.keepalive;

    that.clients[client.id] = client;

    setUpTimer();
    client.connack({ returnCode: 0 });
    that.emit("clientConnected", client);
  });

  client.on("pingreq", function() {
    setUpTimer();
    client.pingresp();
  });

  client.on("subscribe", function(packet) {
    var granted = packet.subscriptions.map(function(e) {
      return 0;
    });

    async.parallel(packet.subscriptions.map(function(s) {
      return function(cb) {
        that.ascoltatore.subscribe(s.topic, forward, cb);
      }
    }), function() {
      client.suback({ messageId: packet.messageId, granted: granted });
    });
  });

  client.on("publish", function(packet) {
    that.ascoltatore.publish(packet.topic, packet.payload);
    that.emit("published", packet, client);
  });

  client.on("unsubscribe", function(packet) {
    async.parallel(packet.unsubscriptions.map(function(topic) {
      return function(cb) {
        that.ascoltatore.unsubscribe(topic, forward, cb);
      }
    }), function() {
      client.unsuback({ messageId: packet.messageId });
    });
  });
  
  client.on("disconnect", function() {
    that.closeConn(client);
  });

  client.on("error", function() {
    that.closeConn(client);
  });
};

/**
 * Closes a client connection.
 *
 * @param {Object} client The client to close
 * @param {Function} callback The callback that will be called
 * when the client will be disconnected
 * @api private
 */
Server.prototype.closeConn = function(client, callback) {
  if(client.id) {
    clearTimeout(client.timer);
    delete this.clients[client.id];
  }
  client.stream.end();
  client.removeAllListeners();
  next(callback);
  this.emit("clientDisconnected", client);
}
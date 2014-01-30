'use strict';

const express = require('express'),
    app = express(),
    server = require('http').createServer(app),
    io = require('engine.io').attach(server),
    zmq = require('zmq'),
    redis = require('redis'),
    redisClient = redis.createClient(),
    Q = require('q'),
    log = require('npmlog');
    // strongloop = require('strong-agent').profile();

log.level = process.env.LOGGING_LEVEL || 'verbose';
redis.print = process.env.REDIS_DEBUG ? redis.print : null;

app.use(express.static(__dirname + '/'));

app.get('/', function(req, res, next){
  res.sendfile('index.html');
});

const port = process.env.PORT || 5000;

server.listen(port, function(){
  log.info('Web socket server (' + process.pid + ') is listening on ', port);
});

/**
 * Data structures
 */

 // These are (currently) redis clients subscribed to different channels
 var resourceSubscribers = {};

/**
 * Public Endpoints
 */
 
io.on('connection', function (socket) {
  handleClientConnected(socket);
});

function handleClientConnected(connectedClient) {
  if (!isValidConnection(connectedClient)) {
    connectedClient.close();
  }

  var resourceId = getResourceId(connectedClient);
  observeResource(connectedClient, resourceId);

  sendCurrentResourceDataToObserver(connectedClient, resourceId);
}

function observeResource(connectedClient, resourceId) {
  var subscriber = resourceSubscribers[resourceId];

  if (!subscriber) {
    log.silly('Creating a new Redis client for resource ' + resourceId);

    subscriber = redis.createClient();
    resourceSubscribers[resourceId] = subscriber;
  }

  subscriber.subscribe(resourceId, redis.print);

  subscriber.on('message', function(channel, message) {
      connectedClient.send(message);
  });

  log.silly('Redis clients in memory: ' + Object.size(resourceSubscribers))
  logNewObserver(resourceId);
}

function sendCurrentResourceDataToObserver(connectedClient, resourceId) {
  // A promise here is not really needed but I like experimenting
  Q.ninvoke(redisClient, 'get', resourceId)
    .then(function(resourceData) {

      if (resourceData) {
        connectedClient.send(resourceData);  
      } else {
        requestResource(resourceId);
      }
    })
    .catch(function (err) {
      log.error('Cant send current resource data to observer ' +
        'for resource ' + resourceId + ':' + err.stack);
    })
    .done();
}

// Publish a resource request for a resrouce that we don't have in Redis
const resourceRequiredPusher = zmq.socket('push').bind('tcp://*:5432');
// Receive new resource data
const resourceUpdatedPuller = zmq.socket('pull').connect('tcp://localhost:5433');

resourceUpdatedPuller.on('message', function (data) {
  handleResourceDataReceived(data);
});

function handleResourceDataReceived(data) {
  var resource = JSON.parse(data); 
  log.verbose('Received resource data for resource ' + resource.id);

  saveResourceData(resource);

  notifyObservers(resource);
}

/**
 * Implementation of public endpoints
 */

function requestResource(resourceId) {
  log.verbose('Requested resource (id: ' + resourceId + ') does not exist, sending a resource request');

  resourceRequiredPusher.send(JSON.stringify({id: resourceId}));
}

function saveResourceData(resource) {
  redisClient.set(resource.id, resource.data, redis.print);
}

function notifyObservers(resource) {
  redisClient.publish(resource.id, resource.data);
}

function getResourceId(clientConnection) {
  return clientConnection.request.query.resourceId;
}

function isValidConnection(clientConnection) {
  var resourceId = getResourceId(clientConnection);

  if (!resourceId) {
    log.warn('Bad resource id (' + resourceId + ') is requested, closing the socket connection');
    return false;
  }

  return true;
}

/**
 * Logging
 */

function logNewObserver(resourceId) {
  log.info('New connection for ' + resourceId + '. Total observers : ', io.clientsCount);
}

/**
 * Graceful termination
 */
function closeAllConnections() {
  resourceRequiredPusher.close();
  resourceUpdatedPuller.close(); 
  io.close();
}

process.on('uncaughtException', function (err) {
  log.error('Caught exception: ' + err.stack);    
  closeAllConnections();
  process.exit(1);
}); 

process.on('SIGINT', function() {
  closeAllConnections();
  process.exit();
});

Object.size = function(obj) {
    var size = 0, key;
    for (key in obj) {
        if (obj.hasOwnProperty(key)) size++;
    }
    return size;
};

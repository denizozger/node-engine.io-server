'use strict';

const express = require('express'),
    app = express(),
    server = require('http').createServer(app),
    io = require('engine.io').attach(server),
    log = require('npmlog'),
    zmq = require('zmq'),
    async = require('async');
    // strongloop = require('strong-agent').profile();
    // memwatch = require('memwatch');

log.level = process.env.LOGGING_LEVEL || 'verbose';

app.use(express.static(__dirname + '/'));

app.get('/', function(req, res, next){
  res.sendfile('index.html');
});

const port = process.env.PORT || 5000;

server.listen(port, function(){
  log.info('Web socket server (' + process.pid + ') is listening on ', port);
});

/**
 * Infrastructure settings and data models
 */ 
var resourceData = {}; // key = resourceId, value = data
var resourceObservers = {}; // key = resourceId, value = [connection1, conn2, ..]

/**
 * Public Endpoints
 */
 
io.on('connection', function (socket) {
  handleClientConnected(socket);
});

function handleClientConnected(clientConnection) {
  if (!isValidConnection(clientConnection)) {
    clientConnection.close();
  }

  var resourceId = getResourceId(clientConnection);
  observeResource(clientConnection, resourceId);

  var existingResourceData = resourceData[resourceId];

  if (existingResourceData) {
    sendResourceDataToObserver(clientConnection, existingResourceData);
  } else {
    requestResource(resourceId);
  }
}

function observeResource(clientConnection, resourceId) {
  var currentResourceObservers = resourceObservers[resourceId] || [];
 
   currentResourceObservers.push(clientConnection);
   resourceObservers[resourceId] = currentResourceObservers;

   logNewObserver(clientConnection, resourceId);
}

// Publish a resource request for a resrouce that we don't have in memory (ie. in resourceData)
const resourceRequiredPusher = zmq.socket('push').bind('tcp://*:5432');
// Receive new resource data
const resourceUpdatedPuller = zmq.socket('pull').connect('tcp://localhost:5433');

resourceUpdatedPuller.on('message', function (data) {
  handleResourceDataReceived(data);
});

function handleResourceDataReceived(data) {
  var resource = JSON.parse(data); 
  log.verbose('Received resource data for resource ' + resource.id);

  storeResourceData(resource);

  notifyObservers(resource.id);
}

/**
 * Implementation of public endpoints
 */

function sendResourceDataToObserver(clientConnection, resourceData) {
  clientConnection.send(resourceData);
}

function requestResource(resourceId) {
  log.verbose('Requested resource (id: ' + resourceId + ') does not exist, sending a resource request');

  resourceRequiredPusher.send(JSON.stringify({id: resourceId}));
}

function storeResourceData(resource) {
  resourceData[resource.id] = resource.data;

  logAllResources();
}

function notifyObservers(resourceId) {
  var currentResourceObservers = resourceObservers[resourceId];
  
  var data = resourceData[resourceId];

  if (currentResourceObservers) {
    async.forEach(currentResourceObservers, function(thisObserver){

      if (thisObserver.readyState !== 'closed') {
        sendResourceDataToObserver(thisObserver, data);
      } else {
        // We need to find the index ourselves, see https://github.com/caolan/async/issues/144
        // Discussion: When a resource terminates, and all observers disconnect but
          // currentResourceObservers will still be full.
        var indexOfTheObserver = getIndexOfTheObserver(currentResourceObservers, thisObserver);

        unobserveResource(currentResourceObservers, resourceId, indexOfTheObserver);
      }
    },
    function(err){
      log.error('Cant broadcast resource data to watching observer:', err);  
    });        
  } else {
    log.verbose('No observers watching this resource: ' + resourceId);
  }
}

function getIndexOfTheObserver(observersWatchingThisResource, observerToFind) {
  for (var i = 0; i < observersWatchingThisResource.length; i++) {
    var observer = observersWatchingThisResource[i];

    if (observer === observerToFind) {
      return i;
    }
  }
}

function unobserveResource(observersWatchingThisResource, resourceId, indexOfTheObserver) {
  observersWatchingThisResource.splice(indexOfTheObserver, 1);

  if (observersWatchingThisResource.length === 0) { 
    removeResource(resourceId);
  } 

  logRemovedObserver();
}

function removeResource(resourceId) {
  log.verbose('Removing resource ( ' + resourceId + ') from memory');

  delete resourceObservers[resourceId];
  delete resourceData[resourceId];   
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
 * Monitoring
 */
//  memwatch.on('leak', function(info) {
//   log.error('Possible memory leak: (ignore this when load testing)');
//   log.error(JSON.stringify(info, null, 2));
//   // process.exit(1);
// });

// memwatch.on('stats', function(stats) {
//   log.warn('GC usage trend:', stats.usage_trend);
// });

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

/**
 * Logging
 */

function logNewObserver(clientConnection, resourceId) {
  log.info('New connection for ' + resourceId + '. This resource\'s observers: ' + 
    resourceObservers[resourceId].length + ', Total observers : ', io.clientsCount);
}

function logRemovedObserver() {
  log.verbose('Connection closed. Total connections: ', io.clientsCount);
  logResourceObservers();
}

function logResourceObservers() {
  for (var resourceId in resourceObservers) {
    if (resourceObservers.hasOwnProperty(resourceId)) {
      log.verbose(resourceObservers[resourceId].length + ' observers are watching ' + resourceId );
    }
  }
}

function logAllResources() {
  log.silly('Total resources in memory: ' + Object.keys(resourceData).length);
  // log.silly(JSON.stringify(resourceData, null, 4));
}


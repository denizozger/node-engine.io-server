'use strict';

const 
  zmq = require('zmq'),
  cluster = require('cluster'),
  log = require('npmlog');

log.level = process.env.LOGGING_LEVEL || 'verbose';

/**
 * Master process
 */ 
if (cluster.isMaster) {

  const express = require('express'),
    app = express(),
    server = require('http').createServer(app),
    io = require('engine.io').attach(server),
    async = require('async'),
    redis = require("redis"),
    redisClient = redis.createClient();
    // strongloop = require('strong-agent').profile();

  log.info('Master ' + process.pid +' is online.');

  redisClient.on("error", function (err) {
    log.error("Redis error: " + err);
  });

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
  const fetcherAddress = process.env.FETCHER_ADDRESS;
  const totalWorkerCount = require('os').cpus().length;

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

  const notifyJobPusher = zmq.socket('push').bind('ipc://notify-job-pusher.ipc', socketErrorHandler);

  function sendResourceDataToObserver(clientConnection, resourceData) {
    clientConnection.send(resourceData);
  }

  function requestResource(resourceId) {
    log.verbose('Requested resource (id: ' + resourceId + ') does not exist, sending a resource request');

    resourceRequiredPusher.send(JSON.stringify({id: resourceId}));
  }

  function storeResourceData(resource)  {
    resourceData[resource.id] = resource.data;

    logAllResources();
  }

  function notifyObservers(resourceId) {
    resourceFetchJobPusher.send(resourceId); 

    log.silly('Notification job sent for resource ' + resourceId);
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
   * Forking worker processes
   */
  
  for (let i = 0; i < totalWorkerCount; i++) {
    cluster.fork();  
  }

  // Listen for workers to come online
  cluster.on('online', function(worker) {
    log.info('Worker ' + worker.process.pid + ' is online.');
  });

  // Handle dead workers
  cluster.on('exit', function(worker, code, signal) {
    log.warn('Worker ' + worker.process.pid + ' died with code ' + code + '. Forking a new one..');
    this.fork();
  });

  /**
   * Disconnecting gracefully
   */
  function closeAllSockets() {
    resourceRequiredPusher.close();
    resourceUpdatedPuller.close(); 
    notifyJobPusher.close();
    io.close();
  }

  process.on('uncaughtException', function (err) {
    log.error('Master process failed, gracefully closing connections: ' + err.stack);    
    closeAllSockets();
    process.exit(1);
  }); 

  process.on('SIGINT', function() {
    closeAllSockets();
    process.exit();
  });

  /**
   * Logging
   */

  function logNewObserver(clientConnection, resourceId) {
    log.info('New connection for ' + resourceId + '. This resource\'s observers: ' + 
      resourceObservers[resourceId].length + ', Total observers : ', io.clientsCount);
  }

  function logAllResources() {
    log.silly('Total resources in memory: ' + Object.keys(resourceData).length);
    // log.silly(JSON.stringify(resourceData, null, 4));
  }

} else {

  /**
   * Worker process
   */

  const notifyJobPuller = zmq.socket('pull').bind('ipc://notify-job-pusher.ipc', socketErrorHandler);

  notifyJobPuller.on('message', function (message) {
    handleNewNotifyJob(message);
  });

  function handleNewNotifyJob(resourceId) {
    log.silly('Worker ' + process.pid + ' received a fetch job for resource ' + fetchJob.id);

    var observers = resourceObservers[resourceId];
    var data = resourceData[resourceId];

    notifyObservers(observers, data);
  }

  function notifyObservers(observers, data) {
    if (observers) {
      async.forEach(currentResourceObservers, function(thisObserver){

        if (thisObserver.readyState !== 'closed') {
          sendResourceDataToObserver(thisObserver, data);
        } else {
          // We need to find the index ourselves, see https://github.com/caolan/async/issues/144
          // Discussion: When a resource terminates, and all observers disconnect but
            // observers will still be full.
          var indexOfTheObserver = getIndexOfTheObserver(observers, thisObserver);

          unobserveResource(observers, resourceId, indexOfTheObserver);
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

  /**
   * Disconnecting gracefully
   */ 
  function closeAllSockets() {
    notifyJobPuller.close();
  }

  process.on('uncaughtException', function (err) {
    log.error('Worker ' + process.pid + ' got an error, the job it was working on is lost: ' + err.stack);    
    closeAllSockets();
    process.exit(1);
  }); 

  process.on('SIGINT', function() {
    closeAllSockets();
    process.exit();
  });

 }

var socketErrorHandler = function (err) {
  if (err) {
    log.error('Socket connection error: ' + err.stack);
    throw new Error(err);
  }
};

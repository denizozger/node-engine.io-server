'use strict';

const 
    cluster = require('cluster'),
    zmq = require('zmq'),
    redis = require('redis'),
    log = require('npmlog');

log.level = process.env.LOGGING_LEVEL || 'verbose';

/**
 * Master process
 */ 
if (cluster.isMaster) {
  log.info('Master (' + process.pid + ') is online.');

  const redisClient = redis.createClient(),
    strongloop = require('strong-agent').profile();
    
  const totalWorkerCount = require('os').cpus().length;

  for (let i = 1; i <= totalWorkerCount; i++) {
    log.info('Forking worker ' + i + ' out of ' + totalWorkerCount);
    cluster.fork();  
  }

  // Listen for workers to come online
  cluster.on('online', function(worker) {
    log.info('Worker ' + worker.id + ' (pid: ' + worker.process.pid + ') is online.');
  });

  // Handle dead workers
  cluster.on('exit', function(worker, code, signal) {
    log.warn('Worker ' + worker.id + ' (pid: ' + worker.process.pid + ') died with code ' + 
      code + '. Forking a new one..');
    this.fork();
  });

  // Receive a resource request for a resource that workers don't have
  const resourceRequiredPuller = zmq.socket('pull').bind('ipc://resource-required-puller.ipc', socketErrorHandler);

   // Push a resource request for a resource that workers don't have
  const resourceRequiredPusher = zmq.socket('push').bind('tcp://*:5432');

  // Receive new resource data
  const resourceUpdatedSubscriber = zmq.socket('sub').connect('tcp://localhost:5433', socketErrorHandler);

  resourceRequiredPuller.on('message', function (message) {
    handleResourceRequested(message);    
  });

  function handleResourceRequested(message) {
    var resourceId = JSON.parse(message).id;
    
    requestResource(resourceId)
  }

  function requestResource(resourceId) {
    log.verbose('Master | Sending a resource request to Fetcher');

    resourceRequiredPusher.send(JSON.stringify({id: resourceId}));

    resourceUpdatedSubscriber.subscribe(resourceId);
  }

  resourceUpdatedSubscriber.on('message', function (data) {
    handleResourceDataReceived(data);
  });

  function handleResourceDataReceived(data) {
    var resource = JSON.parse(getJSONFromPublisherMessage(data)); 

    log.verbose('Master | Received resource data for resource ' + resource.id);

    saveResourceData(resource);

    notifyObservers(resource); 
  }

  function saveResourceData(resource) {
    redisClient.set(resource.id, resource.data, redis.print);
  }

  function notifyObservers(resource) {
    redisClient.publish(resource.id, resource.data);
  }

  // Publisher messages are in format 'channnel message', in our case 'resourceId {resourceData}'
  function getJSONFromPublisherMessage(message) {
    var messageAsString = String(message);

    var indexOfJSON = messageAsString.indexOf('{');

    return messageAsString.substring(indexOfJSON, message.length);
  }

  /**
   * Graceful termination
   */
  function closeAllConnections() {
    resourceRequiredPuller.close();
    resourceRequiredPusher.close(); 
    resourceUpdatedSubscriber.close(); 
  }

  process.on('uncaughtException', function (err) {
    log.error('Master | Caught exception: ' + err.stack);    
    closeAllConnections();
    process.exit(1);
  }); 

  process.on('SIGINT', function() {
    log.warn('Master | SIGINT detected, exiting gracefully.');
    closeAllConnections();
    process.exit();
  });

} else {
  /**
   * Worker process
   */

  const express = require('express'),
    app = express(),
    http = require('http'),
    engine = require('engine.io'),
    redisClient = redis.createClient(),
    Q = require('q');

  // Set how many concurrent sockets http agent can have open per host
  http.globalAgent.maxSockets = Infinity;
  process.setMaxListeners(0);

  // http server
  const server = http.createServer(app);

  // WebSocket server
  const io = engine.attach(server);

  app.use(express.static(__dirname + '/'));

  app.get('/', function(req, res, next){
    res.sendfile('index.html');
  });

  const port = process.env.PORT || 5000;

  server.listen(port, function(){
    log.info('Web socket server (Worker ' + cluster.worker.id + ' - pid: ' + process.pid + ') is listening on ', port);
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
    var redisClientSubscriber = resourceSubscribers[resourceId];

    if (!redisClientSubscriber) {
      log.silly('W' + cluster.worker.id + ' | Creating a new Redis client for resource ' + resourceId);

      redisClientSubscriber = redis.createClient();
      resourceSubscribers[resourceId] = redisClientSubscriber;
    }

    redisClientSubscriber.subscribe(resourceId, redis.print);

    redisClientSubscriber.on('message', function(channel, message) {
        connectedClient.send(message);
    });

    log.silly('W' + cluster.worker.id + ' | Redis clients in memory: ' + Object.size(resourceSubscribers))
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
        log.error('W' + cluster.worker.id+ ' | Cant send current resource data to observer ' +
          'for resource ' + resourceId + ':' + err.stack);
      })
      .done();
  }

  // Publish a resource request for a resource that we don't have in Redis
  const resourceRequiredPusher = zmq.socket('push').connect('ipc://resource-required-puller.ipc', socketErrorHandler);

  /**
   * Implementation of public endpoints
   */

  function requestResource(resourceId) {
    log.verbose('W' + cluster.worker.id + ' | Requested resource (id: ' + resourceId + ') does not exist, sending a resource request to Master');

    resourceRequiredPusher.send(JSON.stringify({id: resourceId}));
  }

  function getResourceId(clientConnection) {
    return clientConnection.request.query.resourceId;
  }

  function isValidConnection(clientConnection) {
    var resourceId = getResourceId(clientConnection);

    if (!resourceId) {
      log.warn('W' + cluster.worker.id + ' | Bad resource id (' + resourceId + ') is requested, closing the socket connection');
      return false;
    }

    return true;
  }

  /**
   * Logging
   */

  function logNewObserver(resourceId) {
    log.info('W' + cluster.worker.id + ' | New connection for ' + resourceId + '. Total observers : ', io.clientsCount);
  }

  /**
   * Graceful termination
   */
  function closeAllConnections() {
    resourceRequiredPusher.close();
    io.close();
  }

  process.on('uncaughtException', function (err) {
    log.error('W' + cluster.worker.id + ' (pid: ' + worker.process.pid + ') | Caught exception: ' + err.stack);    
    closeAllConnections();
    process.exit(1);
  }); 

  process.on('SIGINT', function() {
    closeAllConnections();
    process.exit();
  });

}

var socketErrorHandler = function (err) {
    if (err) {
      log.error('Socket connection error: ' + err.stack);
      throw new Error(err);
    }
    log.info('Socket open.');
};

Object.size = function(obj) {
    var size = 0, key;
    for (key in obj) {
        if (obj.hasOwnProperty(key)) size++;
    }
    return size;
};

'use strict';

const 
    cluster = require('cluster'),
    log = require('npmlog');

log.level = 'verbose';

const totalWorkerCount = require('os').cpus().length;
const maxSockets = Math.floor(2500 / totalWorkerCount);

// 8 workers connecting every 8 seconds makes on average 1 connection per second
const connectionDelay = 2000 * totalWorkerCount; 

//process.env.DEBUG = '*';  

/**
 * Master process
 */ 
if (cluster.isMaster) {
  log.info('Master ' + process.pid +' is online. Total sockets to create will be ' + maxSockets * totalWorkerCount);

  for (let i = 1; i <= totalWorkerCount; i++) {
    log.info('Forking worker ' + i + ' out of ' + totalWorkerCount);
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

} else {
  /**
   * Worker process
   */

  var sockets = [];
  var connectionAttempts = 0;

  function connectToWebSocket() {
    connectionAttempts++;

    log.info('W' + cluster.worker.id + ' Connection attempt ' + connectionAttempts);

  	var socket = require('engine.io-client')('ws://localhost:5000/?resourceId=matchesfeed/' + Math.floor(Math.random() * 10 + 1) + '/matchcentre');
    socket.transports = ['websocket'];
    socket.upgrade = 'false';

    socket.onopen = function() {
      log.info(Date() + ': Connected'); 

      socket.onclose = function() {
        log.warn(Date() + ': Disconnected');  
      };

      socket.onerror = function(e) {
        log.error(Date() + ': ' + e);
        log.error(e.stack);
        log.error(JSON.stringify(e, censor(e), 4));
      };
      
    };

    sockets.push(socket);

    if (connectionAttempts < maxSockets) {
      // if connection delay is 8 seconds, this worker will connect every 100ms to 16100ms (average 8050ms)
      setTimeout(connectToWebSocket, Math.random() * (((connectionDelay * 2) + 100) - 100));
    }
  };

  function censor(censor) {
    return (function() {
      var i = 0;
   
      return function(key, value) {
        if(i !== 0 && typeof(censor) === 'object' && typeof(value) == 'object' && censor == value) 
          return '[Circular]'; 
   
        if(i >= 29) // seems to be a harded maximum of 30 serialized objects?
          return '[Unknown]';
   
        ++i; // so we know we aren't using the original object anymore
   
        return value;  
      }
    })(censor);
  }

  setTimeout(connectToWebSocket, Math.random() * (((connectionDelay * 2) + 100) - 100));

}

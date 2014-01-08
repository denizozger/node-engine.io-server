var log = require('npmlog');

log.level = 'verbose';

var sockets = [];
var maxSockets = 4000; // max 210?
var connectionAttempts = 0;

function connectToWebSocket() {
  connectionAttempts++;

  log.info('Connection attempt ' + connectionAttempts);

	var socket = require('engine.io-client')('ws://localhost:5000/?resourceId=matchesfeed/1/matchcentre');

  socket.onopen = function() {
    log.info(Date() + ': Connected'); 

    socket.onclose = function() {
      log.warn(Date() + ': Disconnected');  
    };
  };

  sockets.push(socket);

  if (connectionAttempts < maxSockets) {
    setTimeout(connectToWebSocket, 100);
  } 
};

connectToWebSocket();

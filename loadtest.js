var log = require('npmlog');

log.level = 'verbose';

var sockets = [];
var maxSockets = 1000; // max 210?
var connectionAttempts = 0;

//process.env.DEBUG = '*';  

function connectToWebSocket() {
  connectionAttempts++;

  log.info('Connection attempt ' + connectionAttempts);

	var socket = require('engine.io-client')('ws://localhost:5000/?resourceId=matchesfeed/1/matchcentre');
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
    
   // if (connectionAttempts < maxSockets) {
   //   setTimeout(connectToWebSocket, 1);
   // }

  };

  sockets.push(socket);

  if (connectionAttempts < maxSockets) {
    setTimeout(connectToWebSocket, 500);
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

connectToWebSocket();

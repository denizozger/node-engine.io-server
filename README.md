# Node.js Engine.io Server 

This Node application perioducally receives JSON data from another web application, and serves it to clients connected to it.

# Installation
``` bash
brew install redis
redis-server
npm install
```

# Running Locally

``` bash
node --harmony server.js
```

## How it works

Please see [node-fetcher](https://github.com/denizozger/node-fetcher) and [node-dataprovider](https://github.com/denizozger/node-dataprovider) implementations too, all three applications work together - although not necessarily.

1. A client connects to the application. ie. ws://node-websocket/some-key
3. App subscribes this client to some-key channel in Redis
2. App checks if there's data for some-key in Redis.
3. If some-key's data is in Redis already, it serves it to connected client
4. If some-key's data is not found, then requests it with via a socket from a specific server, ie. [node-fetcher](https://github.com/denizozger/node-fetcher)
5. Waits to receive data for some-key, over a ZMQ socket. When data is received, saves it to Redis (triggering subscribers to receive the message).

Go to [localhost:5000/?matchesfeed/8/matchcentre](localhost:5000/?matchesfeed/8/matchcentre) for a demo
  
When you have all three applications, you should start node-socketio as:

``` bash
PORT=5000 FETCHER_ADDRESS='http://localhost:4000/fetchlist/new/' REDIS_DEBUG=true node --harmony server.js
```

[![Bitdeli Badge](https://d2weczhvl823v0.cloudfront.net/denizozger/node-websocket/trend.png)](https://bitdeli.com/free "Bitdeli Badge")
 

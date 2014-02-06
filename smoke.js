
require('./index.js'); // zone
var Zone = zone.Zone, Gate = zone.Gate;

var EventEmitter = require('events').EventEmitter;

// Hook process.setTimeout
var realSetTimeout = global.setTimeout;
var realClearTimeout = global.clearTimeout;

global.setTimeout = Gate(zone.root, function(cb, timeout) {
  var gate = this;

  var handle = realSetTimeout(function() {
    gate.schedule(cb);
    gate.close();
    handle = null;
  }, timeout);

  gate.clear = function() {
    if (!handle)
      return;
    realClearTimeout(handle);
    gate.close();
    handle = null;
  };
});

global.clearTimeout = function(gate) {
  gate.clear();
};

// Hook process.setInterval
var realSetInterval = global.setInterval;
var realClearInterval = global.clearInterval;

global.setInterval = Gate(zone.root, function(cb, interval) {
  var gate = this;

  var handle = realSetInterval(function() {
    gate.schedule(cb);
  }, interval);

  gate.clear = function() {
    if (!handle)
      return;

    // Calling realClearTimeout may seem wrong here but
    // timers.js has some weirdness going on that makes this right.
    handle._repeat = false;
    realClearTimeout(handle);

    gate.close();
    handle = null;
  };
});

global.clearInterval = function(gate) {
  gate.clear();
};

// Hook fs.stat
var realStat = require('fs').stat;
var stat = Gate(zone.root, function(file, cb) {
  var gate = this;
  realStat(file, function(err, stats) {
    gate.schedule(function() {
      cb(err, stats);
    });
    gate.close();
  });
});

new Zone(function outer_zone() {
  console.log('Beginning zone %s', zone.name);

  var n = 5;
  var iv = setInterval(function() {
    console.log('setInterval callback in zone %s. Left: %s', zone.name, n--);
    if (n === 0)
      clearInterval(iv);
  }, 500);

  new Zone(function inner_zone() {
    console.log('Beginning zone %s', zone.name);
    setTimeout(function() {
      console.log('setTimeout callback in zone %s', zone.name);
    }, 1000);
  }).setCallback(function(error) {
    console.log('Zone inner_zone ended, back in %s. Error: ', zone.name, error);
  });

  new Zone(function stat_zone() {
    stat('bla', function(error, stats) {
      console.log('stat() callback in zone %s. (error, result) = (%s, %s)', zone.name, error, stats);
      if (error)
        throw error;
    });
  }).setCallback(function(error) {
    console.log('Zone stat_zone ended, back in %s. Error: %s', zone.name, error);
    if (error) throw error;
  });

}).setCallback(function(error, result) {
  console.log('Zone outer_zone ended, back in %s. Error: %s', zone.name, error);
  if (error) throw error;
});

new Zone(function() {
  var ee = new EventEmitter();

  new Zone(function() {
    ee.on('test', function() {
      console.log('bla');
    });
  });

  ee.emit('test');
});
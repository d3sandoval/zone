
exports.Zone = Zone;
exports.Gate = require('./Gate.js');

var assert = require('assert');
var nextTick = process.nextTick;
var uid = require('./uid.js');

global.zone = global.zone || null;

function throwIfError(error) {
  if (error)
    throw error;
}

function noop() {
}

function createBoundZoneConstructor(body, options, callback) {
  return function() {
    var args = arguments;

    function wrappedBody() {
      return body.apply(this, args);
    }
    wrappedBody.name = body.name;

    return new Zone(wrappedBody, options, callback);
  }
}


var isConstructingRoot;

/*
 * - body: runs in zone
 * - options: optional, none (TBD)
 * - callback: optional, alternative to setCallback()
 */
function Zone(body, options, callback) {
  assert(typeof body === 'function');

  if (callback === undefined && typeof options === 'function') {
     callback = options;
     options = undefined;
  }

  if (options == null)
    options = {};

  if (callback == null)
    callback = null;

  if (!(this instanceof Zone))
    return createBoundZoneConstructor(body, options, callback);

  var id = uid();
  var self = this;
  var parent = zone || null;

  var result = undefined;
  var error = undefined;

  var children = Object.create(null);
  var refs = Object.create(null);
  var sentSignals = Object.create(null);

  var callbackQueue = [];
  var refCount = 0;
  var childCount = 0;
  var enterCount = 0;
  var scheduled = false;
  var closed = false;
  var isRoot = isConstructingRoot;

  function invoke(fn, this_, args) {
    try {
      fn.apply(this_ || self, args || []);
    } catch (e) {
      console.log('zone-debug - caught error: ', e, e.stack);
      self.throw(e);
    }
  }

  function flush() {
    assert(enterCount === 1);

    do {
      // Flush the callback queue.
      while (cb = callbackQueue.shift()) {
        invoke.apply(self, cb);
      }

      if (refCount === 0 && !result && !error)
        result = [];

      if (!error && !result)
        break;

      // TODO: better
      var didSignalAny = false;
      for (var id in children) {
        if (!(id in sentSignals)) {
          var child = children[id];
          sentSignals[id] = error;
          didSignalAny = true;
          child.signal(error);
        }
      }
      if (!didSignalAny)
        break;
    } while (callbackQueue.length > 0 ||
             (!error && !result) ||
             childCount > 0);

    if (childCount === 0 &&
        (error || result) &&
        !isRoot) {
      closed = true;
      parent.schedule(finalize);
    }

    scheduled = false;
  }

  function call(function_, this_, arguments_) {
    if (closed)
      throw new Error('This domain is closed');

    enterCount++;

    var previousZone = zone;
    zone = self;

    invoke(function_, this_, arguments_);

    if (enterCount === 1)
      flush();

    zone = previousZone;

    enterCount--;
  }

  function enter() {
     assert(!closed);
     assert(scheduled);
     assert(enterCount === 0);

     enterCount++;
     scheduled = false;

     var previousZone = zone;
     zone = self;

     flush();

     zone = previousZone;

     enterCount--;
  }

  function schedule(function_, this_, arguments_) {
    if (closed)
      throw new Error('This domain is closed');

    if (function_)
      callbackQueue.push([function_, this_, arguments_]);

    if (!scheduled && enterCount === 0) {
      scheduled = true;
      nextTick(enter);
    }
  }

  function finalize() {
    assert.equal(enterCount, 0);
    assert(!scheduled);

    assert(closed === true);

    assert(childCount === 0);
    assert(refCount === 0);

    assert(error || result);

    if (!isRoot)
      parent._unregister(self.id);

    // This logic runs in the context of the parent zone. If an error is thrown, the parent
    // catches it and forwards it to the signaling zone.
    if (callback) {
      return callback.apply(parent, [error].concat(result || []));
    } else {
      throw error;
    }
  }

  if (!isRoot)
    self.root = zone.root;
  else
    self.root = self;

  self.return = function() {
    if (error)
      return;
    else if (result)
      return void self.throw(new Error('Zone result already set.'));

    result = Array.prototype.slice.call(arguments);
    self.schedule();
  };

  self.throw = function(error_) {
    if (error)
      return;

    result = undefined;
    error = error_;

    self.schedule();
  };

  self.callback = function(error_) {
    if (error_)
      return self.throw(error_);
    return self.return.apply(
      null, Array.prototype.slice.apply(arguments, 1));
  };

  self.signal = function(error) {
    self.onsignal(error);
  };

  self.onsignal = function(error) {
    //console.log('signaling %s', self.name);
  };

  self._register = function(id, child, ref) {
    if (id == null)
      id = uid();

    if (ref == null)
      ref = true;

    if (id in children)
      throw new Error("Can't register zone child: already registered");

    childCount++;
    children[id] = child;

    if (ref) {
      refCount++;
      refs[id] = 1;
    }

    return id;
  };

  self._unregister = function(id) {
    if (!(id in children))
      throw new Error("Can't unregister child: not registered");

    childCount--;
    delete children[id];

    if (id in refs) {
      refCount--;
      delete refs[id];
    }
  };

  self._ref = function(id) {
    if (!(id in children))
      throw new Error("Can't ref child: not registered");

    if (id in refs)
      return;

    refCount++;
    refs[id] = 1;
  };

  self._unref = function(id) {
    if (!(id in children))
      throw new Error("Can't unref child: not registered");

    if (!(id in refs))
      return;

    refCount--;
    delete refs[id];
  };

  self.setCallback = function(callback_) {
    if (callback)
      throw new Error('Callback already set');

    callback = callback_;
    callback.zone = self;
  };

  self.parentOf = function(that) {
    if (that === self)
      return false;

    for (; that; that = that.parent)
      if (self === that)
        return true;

    return false;
  };

  self.childOf = function(that) {
    return that.parentOf(self);
  };

  // Set up public properties.
  self.id = id;

  if (!isRoot) {
    self.name = body && body.name || 'Anonymous zone';
    self.parent = parent;
  } else {
    self.name = 'Root zone';
    self.parent = null;
  }

  self.call = call;
  self.schedule = schedule;

  // Reference the parent.
  // TODO: specialize for root.
  if (parent)
    parent._register(id, this, true);

  self.call(body, self);

  if (isRoot)
    zone = self;
}

Zone.prototype = exports;




// Create the root zone
isConstructingRoot = true;
zone = new Zone(noop);
isConstructingRoot = false;

// Monkey-patch require
var Module = require('module').Module;

var realRequire = Module.prototype.require;

Module.prototype.require = function require(path) {
  switch (path) {
    case 'events':
      // This probably isn't right
      return require(__dirname + '/node-lib/events.js');

    default:
      return realRequire.apply(this, arguments);
  }
};


/**
 * Utility functions to capture output from spawned commands
 */
var spawn = require('child_process').spawn;

module.exports = {
  capture: function(cmd, args, opts, callback) {
    var cmd = spawn(cmd, args, opts);
    var stdout = '';
    var stderr = '';
    if (!callback && typeof(opts) == 'function') {
      callback = opts;
      opts = null;
    }
    if (!callback && typeof args == 'function') {
      args = null;
      callback = args;
    }
    cmd.stdout.on('data', function (data) {
      stdout += data;
    });

    cmd.stderr.on('data', function (data) {
      stderr += data;
    });

    cmd.on('close', function (code) {
      if (code !== 0) {
        callback(stderr || code, stdout);
      } else {
        callback(null, stdout);
      }
    });
  }
};
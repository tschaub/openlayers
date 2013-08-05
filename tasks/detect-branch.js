/**
 * Task to build docs
 */

var cmd = require('./lib/cmd');

/** @param {Object} grunt Grunt DSL object. */
module.exports = function(grunt) {
  
  var description = 
    'Helper task to detct the current git branch which is used by ' +
    'some other tasks.  This task is not overly useful by itself.';
    
  grunt.registerTask('detect-current-branch', description, function() {
    var done = this.async();
    cmd.capture('git', ['rev-parse','--abbrev-ref', 'HEAD'], function(err, branch) {
      if (err) {
        grunt.fatal(err);
      }
      grunt.config('branch', branch.trim());
      grunt.log.writeln('current git branch is ' + branch.trim());
      done();
    });
  })
}
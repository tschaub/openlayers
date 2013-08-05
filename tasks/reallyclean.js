/**
 * Task to clean build artifacts and to revert to just cloned out state.
 */

var cmd = require('./lib/cmd');


/** @param {Object} grunt Grunt DSL object. */
module.exports = function(grunt) {

  var description = 'Clean build artifacts.';

  description = 'Removes untracked files and folders from previous builds.'
  grunt.registerTask('reallyclean', description, function() {
    var done = this.async();
    cmd.capture('git', ['clean', '-X', '-d', '-f', '.'], function(err, output) {
      if (err) {
        grunt.fatal(err);
      }
      grunt.verbose.writeln(output);
      done();
    });
  });
};

/**
 * Task to build docs
 */

var cmd = require('./lib/cmd');
var fs = require('fs');

/** @param {Object} grunt Grunt DSL object. */
module.exports = function(grunt) {

  // src controls what files are used to compare to the timestamp file, if none
  // are newer then we'll skip everything.
  grunt.config('doc', {
    src: ['build/src/external/src/exports.js','build/src/external/src/types.js', '<%= files.SRC %>', '<%= files.SHADER_SRC %>', 'doc/template/**']
  });

  grunt.config('clean.doc', ['build/hosted/<%= branch %>/**', 'build/jsdoc-<%= branch %>-timestamp']);

  grunt.config('clean.resources', ['build/hosted/<%= branch %>/resources']);

  grunt.config('copy.doc', {
    src: ['resources/**'],
    dest: 'build/hosted/<%= branch %>/'
  });

  grunt.config('touch.doc', 'build/jsdoc-<%= branch %>-timestamp');
  
  grunt.config('jsdoc', {
    src: ['src', 'doc/index.md'],
    options: {
      'configure': 'doc/conf.json',
      'destination': 'build/hosted/<%= branch %>/apidoc'
    }
  });

  var description = 'Builds documentation for the current branch.';

  // needs to be a multi-task to get automatic filesSrc support
  grunt.registerMultiTask('doc', description, function() {
    var branch = grunt.config('branch');
    var timestamp = fs.statSync('build/jsdoc-'+branch.trim()+'-timestamp').mtime;
    if (this.filesSrc.some(function(f) {
      if (fs.statSync(f).mtime > timestamp) {
        grunt.log.writeln(f + ' is newer, do it!');
      }
      return fs.statSync(f).mtime > timestamp;
    })) {
      grunt.task.run('clean:doc');
      grunt.task.run('copy:doc');
      grunt.task.run('generate-exports');
      grunt.task.run('jsdoc');
      grunt.task.run('touch:doc');
    }
  });
};
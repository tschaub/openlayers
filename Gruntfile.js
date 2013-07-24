module.exports = function(grunt) {

  // http://dl.google.com/closure-compiler/compiler-latest.zip
  // http://closure-linter.googlecode.com/files/closure_linter-latest.tar.gz
  // git clone https://code.google.com/p/closure-library/ build/closure-library
  // 
  
  var fs = require('fs');
  var path = require('path');
  var touch = require('touch');
  
  // return true if timestamp file doesn't exist
  // return true if file is newer that timestamp file
  function isNewer(file, timestamp) {
    return !grunt.file.exists(timestamp) ||
           fs.statSync(timestamp).mtime < fs.statSync(file).mtime;
  }

  // Project configuration.
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    gjslint: {
      source: {
        options: {
          flags: ['--jslint_error=all', '--strict'],
          reporter: {
            name: 'console'
          }
        },
        files: [{
          src: ['src/ol/**/*.js', '!src/ol/**/*shader.js'],
          filter: function(f) {return isNewer(f, 'build/lint-timestamp');}
        }]
      }
    },
    touch: {
      'lint-timestamp': {
        src: ['build/lint-timestamp']
      }
    }
  });

  // Load the plugin that provides the "uglify" task.
  // grunt.loadNpmTasks('grunt-contrib-uglify');
  
  grunt.loadNpmTasks('grunt-gjslint');
  grunt.loadNpmTasks('grunt-touch');
  
  // alias
  grunt.registerTask('lint', [
    'gjslint:source',
    'touch:lint-timestamp'
  ]);
  
  // Default task(s).
  // grunt.registerTask('default', ['uglify']);

};

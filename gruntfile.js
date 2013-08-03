/**
 * Eventually, this documentation should move to the readme.
 *
 * This Grunt configuration makes a number of tasks available for OpenLayers 3
 * development.  See `grunt --help` for task descriptions.
 */


/**
 * @param {Object} grunt Grunt DSL object.
 */
module.exports = function(grunt) {

  grunt.initConfig({
    karma: {
      options: {
        configFile: 'test/karma.conf.js'
      },
      // run Karma with options from configFile
      watch: {},
      // run tests with Karma once
      single: {
        options: {
          singleRun: true
        }
      }
    },
    lint: {
      source:{
        options: {
          flags: ['--jslint_error=all', '--strict'],
          reporter: {
            name: 'console'
          }
        },
        files: [{
          src: ['<%= files.SRC %>']
        }]
      },
      generated: {
        options: {
          flags: ['--jslint_error=all', 
                  '--disable=110',
                  '--limited_doc_files=<%= files.LIMITED_DOC_FILES %>', 
                  '--strict'],
          reporter: {
            name: 'console'
          }
        },
        files: [{
          src: ['<%= files.INTERNAL_SRC %>', '<%= files.EXTERNAL_SRC %>']
        }]
      }
    }
  });


  // this is required by the build task
  grunt.loadNpmTasks('grunt-openlayers');
  grunt.loadNpmTasks('grunt-contrib-copy');
  grunt.loadNpmTasks('grunt-contrib-clean');
  grunt.loadNpmTasks('grunt-jsdoc');

  // pull in all tasks in the tasks dir
  grunt.loadTasks('tasks');

  // other tasks use the current git branch, this ensures we
  // load it in a synchronous way.
  grunt.task.run('detect-current-branch');

  grunt.registerTask('watch', ['karma:watch']);
  grunt.registerTask('default', ['build']);
  

};

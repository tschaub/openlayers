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
  var files = {};
  files.EXPORTS = grunt.file.expand([
    'src/**/*.exports'
  ]);
  files.SRC = grunt.file.expand([
    'src/ol/**/*.js', 
    '!src/ol/**/*?shader.js'
  ]);
  files.EXTERNAL_SRC = grunt.file.expand([
    'build/src/external/externs/types.js',
    'build/src/external/src/exports.js',
    'build/src/external/src/types.js'
  ]);
  files.EXAMPLES = grunt.file.expand([
    'examples/*.html', 
    '!examples/index.html'
  ]);
  files.EXAMPLES_SRC = grunt.file.expand([
    'examples/*.js', 
    '!examples/*.combined.js', 
    '!examples/bootstrap/*',
    '!examples/font-awesome/*', 
    '!examples/Jugl.js', 
    '!examples/jquery.min.js', 
    '!examples/loader.js', 
    '!examples/example-list.js'
  ]);
  files.EXAMPLES_JSON = files.EXAMPLES.map(function(f) {
    return 'build/' + f.replace(/\.html/, '.json');
  });
  files.EXAMPLES_COMBINED = files.EXAMPLES.map(function(f) {
    return 'build/' + f.replace(/\.html/, '.combined.js');
  });
  files.INTERNAL_SRC = grunt.file.expand([
    'build/src/internal/src/requireall.js',
    'build/src/internal/src/types.js'
  ]);
  files.GLSL_SRC = grunt.file.expand([
    'src/**/*.glsl'
  ]);
  files.JSDOC_SRC = grunt.file.expand([
    'src/**/*.jsdoc'
  ]);
  files.SHADER_SRC = grunt.file.expand([
    'src/**/*?shader.js'
  ]);
  files.SPEC = grunt.file.expand([
    'test/spec/**/*.js'
  ]);
  files.LIMITED_DOC_FILES = grunt.file.expand([
    'externs/*.js', 
    'build/src/external/externs/*.js'
  ]);
  
  // Project configuration.
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    files: files,
    gjslint: {
      source: {
        options: {
          flags: ['--jslint_error=all', '--strict'],
          reporter: {
            name: 'console'
          }
        },
        files: [{
          src: ['<%= files.SRC %>'],
          filter: function(f) {return isNewer(f, 'build/lint-timestamp');}
        }]
      },
      generated: {
        options: {
          flags:['--jslint_error=all', '--disable=110','--limited_doc_files=<%= files.LIMITED_DOC_FILES %>', '--strict'],
          reporter: {
            name: 'console'
          }
        },
        src: ['<%= files.INTERNAL_SRC %>', '<%= files.EXTERNAL_SRC %>'],
        filter: function(f) { return isNewer(f, 'build/lint-generated-timestamp'); }
      }
    },
    touch: {
      'lint-timestamp': {
        src: ['build/lint-timestamp']
      },
      'lint-generated-timestamp': {
        src: ['build/lint-generated-timestamp']
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
    'touch:lint-timestamp',
    'gjslint:generated',
    'touch:lint-generated-timestamp'
  ]);
  
  grunt.registerTask('listfiles', 'helper task to dump out a named list of files (first arg) for comparison to the console or to a file (optional second arg)', function() {
    var args = Array.prototype.slice.call(arguments);
    var config;

    if (args.length < 1) {
      grunt.fatal('specify a list to dump');
    }

    config = grunt.config('files.'+args[0]);
    
    if (!config || !Array.isArray(config)) {
      grunt.fatal(args[0] + ' is not a valid file list');
    } else {
      if (args.length > 1) {
        grunt.file.write(args[1], config.sort().join('\n'));
      } else {
        grunt.log.write(config.sort().join('\n'));
      }
    }
  });
  
  // Default task(s).
  // grunt.registerTask('default', ['uglify']);

};

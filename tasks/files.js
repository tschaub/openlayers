

/**
 * Task to register various combinations of files in the grunt config 
 * object
 */


/** @param {Object} grunt Grunt DSL object. */
module.exports = function(grunt) {

  var files = {};
  
  if (!grunt.config('files')) {
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
    grunt.config('files', files);
    
    // debug only
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
  }
};
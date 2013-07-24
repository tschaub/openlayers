

/**
 * Task to run lint tasks with gjslint
 */
var fs = require('fs');

/** @param {Object} grunt Grunt DSL object. */
module.exports = function(grunt) {
  
  grunt.loadNpmTasks('grunt-gjslint');
  grunt.loadNpmTasks('grunt-touch');

  var description = 'Runs gjslint on source files and generated files.';

  grunt.registerMultiTask('lint', description, function() {
    var tgt = this.target;
    grunt.config.requires('files');
    grunt.config('gjslint.'+tgt, grunt.config('lint.'+this.target));
    grunt.config('gjslint.'+tgt+'.files[0].filter', function(f) {
      return isNewer(f, 'build/lint-'+tgt);
    });
    grunt.task.run('gjslint:'+tgt);
    grunt.config('touch.lint-'+tgt, {src:['build/lint-'+this.target]});
    grunt.task.run('touch:lint-'+tgt);
  });
};

/** 
 * @param {String} file path to the file being tested. 
 * @param {String} ref path to the reference file. 
 */
function isNewer(file, ref) {
  return !fs.existsSync(ref) ||
         fs.statSync(ref).mtime < fs.statSync(file).mtime;
}
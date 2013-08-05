/**
 * Task to check source code for todo and fixme comments
 */

/** @param {Object} grunt Grunt DSL object. */
module.exports = function(grunt) {
  
  grunt.renameTask('todos', 'todo');
  grunt.config('todo', {
    options: {
      verbose: false
    },
    source: {
      src: ['<%= files.SRC %>']
    }
  });
  
}
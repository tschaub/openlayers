

/**
 * Task to generate exports
 */

/** @param {Object} grunt Grunt DSL object. */
module.exports = function(grunt) {
  
  grunt.config('generate-exports', {
    exports: {
      options: {
        args: ['--exports']
      },
      src: ['src/objectliterals.jsdoc', '<%= files.EXPORTS %>'],
      dest: 'build/src/external/src/exports.js'
    },
    types: {
      options: {
        args: ['--typedef']
      },
      src: ['src/objectliterals.jsdoc'],
      dest: 'build/src/external/src/types.js'
    }
  });
  
  var description = 'Generate exports';
  
  // build/src/external/src/exports.js: python bin/generate-exports.py --exports src/objectliterals.jsdoc src/ol/animation.exports src/ol/attribution.exports src/ol/collection.exports src/ol/coordinate.exports src/ol/deviceorientation.exports src/ol/easing.exports src/ol/extent.exports src/ol/feature.exports src/ol/geolocation.exports src/ol/geom.exports src/ol/map.exports src/ol/mapbrowserevent.exports src/ol/object.exports src/ol/ol.exports src/ol/overlay.exports src/ol/style.exports src/ol/view2d.exports src/ol/control/attributioncontrol.exports src/ol/control/control.exports src/ol/control/controldefaults.exports src/ol/control/fullscreencontrol.exports src/ol/control/logocontrol.exports src/ol/control/mousepositioncontrol.exports src/ol/control/scalelinecontrol.exports src/ol/control/zoomcontrol.exports src/ol/control/zoomslidercontrol.exports src/ol/control/zoomtoextentcontrol.exports src/ol/dom/input.exports src/ol/expr/expression.exports src/ol/geom2/linestringcollection.exports src/ol/geom2/pointcollection.exports src/ol/interaction/condition.exports src/ol/interaction/dragrotateandzoom.exports src/ol/interaction/interactiondefaults.exports src/ol/layer/imagelayer.exports src/ol/layer/layer.exports src/ol/layer/tilelayer.exports src/ol/layer/vectorlayer.exports src/ol/layer/vectorlayer2.exports src/ol/parser/geojson.exports src/ol/parser/gpx.exports src/ol/parser/kml.exports src/ol/parser/wkt.exports src/ol/parser/ogc/gml.exports src/ol/parser/ogc/wmscapabilities.exports src/ol/parser/ogc/wmtscapabilities.exports src/ol/proj/proj.exports src/ol/renderer/canvas/canvasmaprenderer.exports src/ol/source/bingmapssource.exports src/ol/source/debugtilesource.exports src/ol/source/mapquestsource.exports src/ol/source/osmsource.exports src/ol/source/singleimagewmssource.exports src/ol/source/stamensource.exports src/ol/source/staticimagesource.exports src/ol/source/tiledwmssource.exports src/ol/source/tilejsonsource.exports src/ol/source/tilesource.exports src/ol/source/vectorsource.exports src/ol/source/vectorsource2.exports src/ol/source/wmtssource.exports src/ol/tilegrid/tilegrid.exports src/ol/tilegrid/wmtstilegrid.exports src/ol/tilegrid/xyztilegrid.exports
  // build/src/external/src/types.js: python bin/generate-exports.py --typedef src/objectliterals.jsdoc

  var cmd = require('./lib/cmd');
  
  grunt.registerMultiTask('generate-exports', description, function() {
    
    grunt.config.requires('files');

    var done = this.async();
    var options = this.options({
      cmd: 'bin/generate-exports.py',
      args: ['--exports']
    })
    
    var args = [options.cmd];
    args = args.concat(options.args);
    args = args.concat(this.filesSrc);

    var dest = this.data.dest;
      
    cmd.capture('python', args, function(err, output) {
      if (err) {
        grunt.fatal(err);
      }
      
      grunt.file.write(dest, output);
      done();
    });
  })
};
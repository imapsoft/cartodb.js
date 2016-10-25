var MultiPathViewBase = require('./multi-path-view-base');
var PolygonView = require('./polygon-view');

var MultiPolygonView = MultiPathViewBase.extend({
  PathViewClass: PolygonView,
  geoJSONType: 'MultiPolygon'
});

module.exports = MultiPolygonView;

var _ = require('underscore');
var Backbone = require('backbone');
var WindshaftConfig = require('./config');
var log = require('../cdb.log');
var Request = require('./request');
var RequestTracker = require('./request-tracker');
var WindshaftError = require('./error');

/* The max number of times the same map can be instantiated */
var MAP_INSTANTIATION_LIMIT = 3;

var WindshaftMap = Backbone.Model.extend({
  initialize: function (attrs, options) {
    if (!options.client) {
      throw new Error('client option is required');
    }
    // TODO: We could use the layerGroupModel instead! Only contains layers of type 'CartoDB' and 'Torque'
    if (!options.layersCollection) {
      throw new Error('layersCollection option is required');
    }
    if (!options.dataviewsCollection) {
      throw new Error('dataviewsCollection option is required');
    }
    if (!options.analysisCollection) {
      throw new Error('analysisCollection option is required');
    }
    if (!options.modelUpdater) {
      throw new Error('modelUpdater option is required');
    }

    this.client = options.client;
    this.set({
      urlTemplate: this.client.urlTemplate,
      userName: this.client.userName
    });

    this._layersCollection = options.layersCollection;
    this._dataviewsCollection = options.dataviewsCollection;
    this._analysisCollection = options.analysisCollection;
    this._modelUpdater = options.modelUpdater;

    this._requestTracker = new RequestTracker(MAP_INSTANTIATION_LIMIT);
  },

  toJSON: function () {
    throw new Error('Subclasses of windshaft/map-base must implement .toJSON');
  },

  // TODO: Move this somewhere else and keep this class as a wrapper for windshaft responses
  createInstance: function (options, includeFilters) {
    var filters;
    options = options || {};

    try {
      var payload = this.toJSON();
      var params = this._getParams();

      if (includeFilters) {
        filters = this._getFilterParamFromDataviews();
        if (!_.isEmpty(filters)) {
          params.filters = filters;
        }
      }

      var request = new Request(payload, params, options);
      if (this._canPerformRequest(request)) {
        this._performRequest(request);
      } else {
        log.error('Maximum number of subsequent equal requests to the Maps API reached (' + MAP_INSTANTIATION_LIMIT + '):', payload, params);
        options.error && options.error();
      }
    } catch (e) {
      var error = new WindshaftError({
        message: e.message
      });
      this._modelUpdater.setErrors([ error ]);

      log.error(e.message);
      options.error && options.error();
    }
  },

  _canPerformRequest: function (request) {
    return this._requestTracker.canRequestBePerformed(request);
  },

  _trackRequest: function (request, response) {
    this._requestTracker.track(request, response);
  },

  _performRequest: function (request) {
    var payload = request.payload;
    var params = request.params;
    var options = request.options;
    this.client.instantiateMap({
      mapDefinition: payload,
      params: params,
      success: function (response) {
        this._trackRequest(request, response);
        this.set(response);
        this._modelUpdater.updateModels(this, options.sourceId, options.forceFetch);
        this.trigger('instanceCreated');
        options.success && options.success(this);
      }.bind(this),
      error: function (response) {
        this._trackRequest(request, response);
        var windshaftErrors = this._getErrorsFromResponse(response);
        this._modelUpdater.setErrors(windshaftErrors);
        options.error && options.error();
      }.bind(this)
    });
  },

  _getErrorsFromResponse: function (response) {
    if (response.errors_with_context) {
      return _.map(response.errors_with_context, function (error) {
        return new WindshaftError(error);
      });
    }
    if (response.errors) {
      return [
        new WindshaftError({ message: response.errors[0] })
      ];
    }

    return [];
  },

  _getParams: function () {
    var params = {
      stat_tag: this.get('statTag')
    };

    if (this.get('apiKey')) {
      params.api_key = this.get('apiKey');
    } else if (this.get('authToken')) {
      params.auth_token = this.get('authToken');
    }

    return params;
  },

  _getFilterParamFromDataviews: function () {
    return this._dataviewsCollection.reduce(function (filters, dataview) {
      var filter = dataview.filter;
      if (filter && !filter.isEmpty()) {
        filters['dataviews'] = filters['dataviews'] || {};
        _.extend(filters['dataviews'], filter.toJSON());
      }
      return filters;
    }, {});
  },

  getBaseURL: function (subhost) {
    return [
      this._getHost(subhost),
      WindshaftConfig.MAPS_API_BASE_URL,
      this.get('layergroupid')
    ].join('/');
  },

  _getHost: function (subhost) {
    var userName = this.get('userName');
    var protocol = this._useHTTPS() ? 'https' : 'http';
    subhost = subhost ? subhost + '.' : '';
    var host = this.get('urlTemplate').replace('{user}', userName);
    var cdnHost = this.get('cdn_url') && this.get('cdn_url')[protocol];
    if (cdnHost) {
      host = [protocol, '://', subhost, cdnHost, '/', userName].join('');
    }

    return host;
  },

  _useHTTPS: function () {
    return this.get('urlTemplate').indexOf('https') === 0;
  },

  /**
   * Returns the indexes of the layer of a given type, as the tiler kwows it.
   *
   * @param {string|array} layerType - Type of layer
   */
  getLayerIndexesByType: function (layerType) {
    return _.reduce(this._getLayers(), function (layerIndexes, layer, index) {
      if (layer.type === layerType) {
        layerIndexes.push(index);
      }
      return layerIndexes;
    }, []);
  },

  getDataviewMetadata: function (dataviewId) {
    var dataviews = this._getDataviews();
    if (dataviews && dataviews[dataviewId]) {
      return dataviews[dataviewId];
    }

    // Try to get dataview's metatadta from the 'widgets' dictionary inside the metadata of each of the layers
    dataviews = {};
    var layersDataviews = _.compact(_.map(this._getLayers(), function (layer) { return layer.widgets; }));
    _.each(layersDataviews, function (layerDataviews) {
      _.extend(dataviews, layerDataviews);
    });

    if (dataviews && dataviews[dataviewId]) {
      return dataviews[dataviewId];
    }
  },

  getAnalysisNodeMetadata: function (analysisId) {
    var metadata = {};
    var nodes = _.map(this._getAnalyses(), function (analysis) {
      return analysis.nodes;
    });
    _.each(nodes, function (node) {
      _.extend(metadata, node);
    });

    return metadata[analysisId];
  },

  getSupportedSubdomains: function () {
    if (!this._useHTTPS()) {
      return ['0', '1', '2', '3'];
    }

    return [''];
  },

  getLayerMetadata: function (layerIndex) {
    var layerMeta = {};
    var layers = this._getLayers();
    if (layers && layers[layerIndex]) {
      layerMeta = layers[layerIndex].meta || {};
    }
    return layerMeta;
  },

  _getLayers: function () {
    return (this.get('metadata') && this.get('metadata').layers) || [];
  },

  _getDataviews: function () {
    return (this.get('metadata') && this.get('metadata').dataviews) || [];
  },

  _getAnalyses: function () {
    return (this.get('metadata') && this.get('metadata').analyses) || [];
  }
});

module.exports = WindshaftMap;

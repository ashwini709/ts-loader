var EventEmitter = require('events').EventEmitter;
var all = require('q').all;
var Promise = window.Promise = require('q').Promise;
var semver = require('semver');
var throat = require('throat')(Promise);
var SparkMD5 = require('spark-md5');

var loaderConfig = require('json!../package.json');
var fs = require('./local-storage-promise-fs');
var objectAssign = require('./object-assign');
var xhrPromise = require('./xhr-promise');

var totalBytes, loadedBytes;

function updateLocalHash(file) {
  localHashes[file.manifestEntry.path] = file.md5;
  stringified = JSON.stringify(localHashes);
  window.localStorage.setItem('localHashes', stringified);
}

function getLocalHashes() {
  var content = window.localStorage.getItem('localHashes');
  if (!content) {
    return {};
  }

  try {
    return JSON.parse(content);
  } catch (e) {
    console.warn('Error reading localHashes from localStorage.', e)
    return {};
  }
}

var localHashes = getLocalHashes();

function getAppHost() {
  return new Promise(function (resolve, reject) {
    if (!window.plugins) {
      return resolve();
    }
    resolve(window.plugins.appPreferences.fetch('appServer'));
  });
}

function getAppManifest(config) {
  var path = config.manifestFile;

  var file = { manifestEntry: { path: path } };
  var manifestEntry = file.manifestEntry;

  var fileBuffer, contentType;

  return fs.readJSON(path).then(function (content) {
    manifestEntry.hash = localHashes[path];
    file.content = content;
  }, function (error) {
    if (error && error.code !== 'ENOENT') {
      throw error;
    }
  }).then(function () {
    var url = (config.appHost || '') + '/' + manifestEntry.path;

    return xhrPromise(url);
  }).then(function (xhr) {
    file.fileBuffer = xhr.response;
    file.contentType = xhr.contentType;

    if (!config.performMD5) {
      return;
    }
    return getMD5(file.fileBuffer);
  }).then(function (md5) {
    file.md5 = md5;

    if (md5 && manifestEntry.hash === md5) {
      return file;
    }

    manifestEntry.hash = md5;

    file.blob = new Blob([file.fileBuffer], { type: file.contentType });

    return writeFile(file, config).then(function () {
      return new Promise(function (resolve, reject) {
        var blob = file.blob;
        var fileReader= new FileReader();

        fileReader.onload = function(e) {
          file.content = JSON.parse(e.target.result);

          resolve(file);
        };

        fileReader.onerror = function (e) {
          reject(e);
        };

        fileReader.readAsText(blob);
      });
    });
  }).then(function () {
    var manifest = file.content;
    if (!semver.satisfies(manifest.appVersion, config.supportedAppVersion)) {
      throw new Error('Unsupported application version: expected \'' + config.supportedAppVersion + '\' and got \'' + manifest.version + '\'.');
    }

    if (!semver.satisfies(manifest.manifestVersion, config.supportedManifestVersion)) {
      throw new Error('Your application version is too low. Please visit the App Store and update your application.');
    }

    return file;
  });
}

function getFilesToLoad(manifest, config) {
  return new Promise(function (resolve, reject) {
    var filesToLoad = manifest.domNodes.map(function (nodeInfo) {
      return manifest.files[nodeInfo.path];
    }).filter(function (file) {
      return file && (!config.useLocalCache || file.hash != localHashes[file.path]);
    });

    return resolve(filesToLoad);
  });
}

function writeFile(file, config) {
  var path = file.manifestEntry.path;
  var contentType = file.contentType;

  var blob = file.blob || new Blob([file.fileBuffer], { type: contentType });

  return fs.ensure(fs.dirname(path)).then(function () {
    return fs.file(path, { create: true });
  }).then(function (fileEntry) {
    return new Promise(function (resolve, reject) {
      if (!config.useLocalCache) {
        return resolve();
      }

      fileEntry.createWriter(function (writer) {
        writer.onwriteend = function () {
          resolve();
        };
        writer.onerror = reject;
        writer.write(blob);
      }, reject);
    });
  }).then(function () {
    if (config.useLocalCache) {
      updateLocalHash(file);
    }

    return file;
  });
}

function getMD5(fileEntry) {
  return new Promise(function (resolve, reject) {
    if (window.md5chksum) {
      md5chksum.file(fileEntry, resolve, reject);
    } else {
      md5 = SparkMD5.ArrayBuffer.hash(fileEntry);
      resolve(md5);
    }
  });
}

function downloadFile(config, manifestEntry) {
  var appHost = config.appHost;
  var url = appHost + '/' + manifestEntry.path + '?' + manifestEntry.hash;

  var previousBytes = 0;

  var fileBuffer = null;
  var contentType = null;

  return xhrPromise(url).progress(function (event) {
    var bytes = event.loaded - previousBytes;
    previousBytes = event.loaded;

    // Firefox likes to report compressed bytes loaded, so we have to estimate how many uncompressed
    // bytes have been loaded.
    var estimatedBytes = 0;

    if (event.total && event.total !== manifestEntry.size) {
      estimatedBytes = Math.floor(manifestEntry.size *  event.loaded / event.total);
    }

    loadedBytes += estimatedBytes || bytes;

    loader.emit('progress', loadedBytes, totalBytes);
  }).then(function (xhr) {
    fileBuffer = xhr.response;
    contentType = xhr.contentType;

    if (!config.performMD5) {
      return manifestEntry.hash;
    }

    return getMD5(fileBuffer);
  }).then(function (md5) {
    if (md5 !== manifestEntry.hash) {
      throw new Error('md5 mismatch: ' + manifestEntry.path + ' ' + manifestEntry.hash + ' computed: ' + md5);
    }

    return { manifestEntry: manifestEntry, fileBuffer: fileBuffer, contentType: contentType, md5: md5 };
  });
}

function downloadFiles(config, files) {
  totalBytes = files.reduce(function (total, file) { return total + file.size }, 0);
  loadedBytes = 0;

  var promises = files.map(throat(5, function (file) {
    return downloadFile(config, file);
  }));

  return all(promises);
}

function updateNodeAttributes(node, nodeInfo) {
  if (nodeInfo.attributes) {
    for (var key in nodeInfo.attributes) {
      node.setAttribute(key, nodeInfo.attributes[key]);
    }
  }
}

function createLocalScriptNode(fileCache, nodeInfo, config) {
  return new Promise(function (resolve, reject) {
    var node = document.createElement('script');
    node.setAttribute('type', 'text/javascript');

    updateNodeAttributes(node, nodeInfo);

    document.body.appendChild(node);

    if (fileCache[nodeInfo.path].content) {
      node.text = fileCache[nodeInfo.path].content;
      node.id = nodeInfo.path;
      return resolve(node);
    }

    var fileBuffer = fileCache[nodeInfo.path].fileBuffer;
    var blob = new Blob([fileBuffer], {type: 'text/javscript'});

    var fileReader= new FileReader();

    fileReader.onload = function(e) {
      var text = e.target.result;

      if (config.rewriteSourcemaps) {
        var sourceIndex = text.lastIndexOf('\n//# sourceMappingURL=');

        if (sourceIndex === -1) {
          sourceIndex = text.length;
        }

        newSource = '\n//# sourceMappingURL=' + nodeInfo.path.replace('.js', '.map');

        text = text.substring(0, sourceIndex).concat(newSource);
      }

      node.text = text;
      node.id = nodeInfo.path;
      resolve(node);
    };

    fileReader.onerror = function (e) {
      if (nodeInfo.optional) {
        return resolve(node);
      }
      console.error('error reading: ', nodeInfo, e);
      reject(e);
    };

    fileReader.readAsText(blob);
  });
}

function createRemoteScriptNode(nodeInfo) {
  return new Promise(function (resolve, reject) {
    var node = document.createElement('script');
    node.setAttribute('type', 'text/javascript');

    updateNodeAttributes(node, nodeInfo);

    node.onload = function () {
      resolve(node);
    };

    node.onerror = function (error) {
      if (nodeInfo.optional) {
        return resolve(node);
      }
      console.error('error loading: ', nodeInfo, error);
      reject(error);
    };

    node.setAttribute('src', nodeInfo.path);

    document.body.appendChild(node);
  });
}

function createLocalStyleSheetNode(fileCache, nodeInfo) {
  return new Promise(function (resolve, reject) {
    var node = document.createElement('style');
    node.setAttribute('type', 'text/css');

    updateNodeAttributes(node, nodeInfo);

    document.body.appendChild(node);

    if (fileCache[nodeInfo.path].content) {
      node.innerHTML = fileCache[nodeInfo.path].content;
      node.id = nodeInfo.path;
      return resolve(node);
    }

    var fileBuffer = fileCache[nodeInfo.path].fileBuffer;
    var blob = new Blob([fileBuffer], {type: 'text/css'});

    var fileReader= new FileReader();

    fileReader.onload = function(e) {
      try {
        node.innerHTML = e.target.result
      } catch (e) {
        console.error(e);
        return reject(e);
      }
      node.id = nodeInfo.path;
      resolve(node)
    };

    fileReader.onerror = function (e) {
      if (nodeInfo.optional) {
        return resolve(node);
      }
      console.error('error reading: ', nodeInfo, e);
      reject(e);
    };

    fileReader.readAsText(blob);
  });
}

function createRemoteStyleSheetNode(nodeInfo) {
  return new Promise(function (resolve, reject) {
    var node = document.createElement('link');

    node.setAttribute('type', 'text/css');
    node.setAttribute('rel', 'stylesheet');

    updateNodeAttributes(node, nodeInfo);

    node.onload = resolve;

    node.onerror = function (error) {
      if (nodeInfo.optional) {
        return resolve();
      }
      console.error('error loading: ', nodeInfo, error);
      reject(error);
    };

    node.setAttribute('href', nodeInfo.path);

    document.body.appendChild(node);
  });
}

function createNode(fileCache, nodeInfo, config) {
  var isCached = fileCache.hasOwnProperty(nodeInfo.path);

  var type = isCached ? fileCache[nodeInfo.path].manifestEntry.type : nodeInfo.type;

  if (type === 'js') {
    if (isCached) {
      return createLocalScriptNode(fileCache, nodeInfo, config);
    }
    return createRemoteScriptNode(nodeInfo);
  }

  if (type === 'css') {
    if (isCached) {
      return createLocalStyleSheetNode(fileCache, nodeInfo);
    }
    return createRemoteStyleSheetNode(nodeInfo);
  }

  throw new Error('Unknown node type: ' + type);
}

function loadFilesFromCache(manifest, fileCache, files) {
  var filesToLoad = [];

  files.forEach(function (file) {
    fileCache[file.manifestEntry.path] = file;
  });

  manifest.domNodes.forEach(function (nodeInfo) {
    if (!fileCache[nodeInfo.path] && manifest.files[nodeInfo.path]) {
      filesToLoad.push(manifest.files[nodeInfo.path]);
    }
  });

  return filesToLoad.map(function (file) {
    fs.read(file.path).then(function (content) {
      fileCache[file.path] = { manifestEntry: file, content: content };
    });
  });
}

var loader = new EventEmitter();

loader.load = function (runtimeConfig) {
  // We're passing in a dataSet as runtimeConfig and Safari's Object.assign doesn't work with it
  // so we use our own objectAssign that doesn't mutate data.

  var config = this.config = objectAssign(loaderConfig, runtimeConfig);

  var manifest = this.manifest = {};
  var fileCache = this.fileCache = {};

  getAppHost().then(function (appHost) {
    config.appHost = appHost || '';
  }, function (error) {
    console.warn("Error reading appHost from appPreferences, using default.", error);
  }).then(function () {
    return getAppManifest(config);
  }).then(function (appManifest) {
    fileCache[config.manifestFile] = appManifest;
    manifest = appManifest.content;

    return getFilesToLoad(manifest, config);
  }).then(function (files) {
    return downloadFiles(config, files);
  }).then(function (files) {
    return all(files.map(function (file) {
      return writeFile(file, config);
    }));
  }).then(function (files) {
    return loadFilesFromCache(manifest, fileCache, files);
  }).then(function () {
    return all(manifest.domNodes.map(throat(1, function (nodeInfo) {
      return createNode(fileCache, nodeInfo, config);
    })));
  }).then(function () {
    loader.emit('loaded');
  }).catch(function (e) {
    console.error('loader error', e);
    if (window.Bugsnag) {
      window.Bugsnag.notifyException(e);
    }
    loader.emit('error', e.message || JSON.stringify(e, null, 2));
  });
};

module.exports = loader;

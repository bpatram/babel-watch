'use strict';

const path = require('path');
const fs = require('fs');
const sourceMapSupport = require('source-map-support');

let sources = {};
let maps = {};

let pipeFd;
const BUFFER = new Buffer(10 * 1024);

// Node by default uses '.js' loader to load all the files with unknown extensions
const DEFAULT_LOADER = require.extensions['.js'];

function readLength(fd) {
  let bytes = 0;
  while (bytes !== 4) {
    bytes = fs.readSync(fd, BUFFER, 0, 4);
  }
  return BUFFER.readUInt32BE(0);
}

function readFileFromPipeSync(fd) {
  let length = readLength(fd);
  let result = new Buffer(0);
  while (length > 0) {
    const newBytes = fs.readSync(fd, BUFFER, 0, Math.min(BUFFER.length, length));
    length -= newBytes;
    result = Buffer.concat([result, BUFFER], result.length + newBytes);
  }
  return result.toString();
}

function babelWatchLoader(module_, filename, defaultHandler) {
  // apparently require loader needs to be synchronous, which
  // complicates things a little bit as we need to get source
  // file from the parent process synchronously.
  // The best method I've found so far is to use readFileSync on
  // a named unix pipe (mkfifo). All the alternative ways would
  // require writing native code which usually brings large
  // dependencies to the project and I prefer to avoid that
  process.send({
    event: 'babel-watch-filename',
    filename: filename,
  });
  const source = readFileFromPipeSync(pipeFd);
  const map = readFileFromPipeSync(pipeFd);
  if (source) {
    maps[filename] = map && JSON.parse(map);
    module_._compile(source, filename);
  } else {
    defaultHandler(module_, filename);
  }
}

function registerExtension(ext) {
  const defaultHandler = require.extensions[ext] || DEFAULT_LOADER;
  require.extensions[ext] = (module_, filename) => {
    // ignore node_modules by default. don't you dare contacting the parent process!
    if (filename.split(path.sep).indexOf('node_modules') < 0) {
      babelWatchLoader(module_, filename, defaultHandler);
    } else {
      defaultHandler(module_, filename);
      if (filename.indexOf('/node_modules/source-map-support/') !== -1 && module_.exports.install !== undefined) {
        // When app is running in babel-watch the source-map-support library should not be used by separately. The
        // runner process is initializing source-map-support passing a special source map loader that makes it possible
        // to use maps generated by the "parent" process instead of reading them from the filesystem.
        // We don't allow for source-map-support library to be reinitialized
        module_.exports.install = () => {};
      }
    }
  };
}

function replaceExtensionHooks(extensions) {
  for (const ext in require.extensions) {
    registerExtension(ext);
  }
  for (let i = 0; i < extensions.length; i++) {
    const ext = extensions[i];
    if (!(ext in require.extensions)) {
      registerExtension(ext);
    }
  }
}

process.on('message', (options) => {
  if (!options || options.event !== 'babel-watch-start') return;
  replaceExtensionHooks(options.transpileExtensions);
  sourceMapSupport.install({
    environment: 'node',
    handleUncaughtExceptions: !!options.handleUncaughtExceptions,
    retrieveSourceMap(filename) {
      const map = maps && maps[filename];
      if (map) {
        return {
          url: filename,
          map: map
        };
      }
      return null;
    },
  });
  // We don't allow for source-map-support library to be reinitialized (see comment in registerExtension function)
  sourceMapSupport.install = () => {};

  pipeFd = fs.openSync(options.pipe, 'r');
  process.argv = ["node"].concat(options.args);
  require('module').runMain();
});

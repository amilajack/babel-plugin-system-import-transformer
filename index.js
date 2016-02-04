var path = require('path');

module.exports = function (babel) {
  var t = babel.types;

  function getImportPath(file, relativeImportPath) {
    var filename = file.opts.filename;
    var filePath = filename.replace(/[^\/]+$/, '');
    var result = path.join(filePath, relativeImportPath);
    return result;
  }

  function getImportModuleName(file, importPath) {
    var importedModulePath = getImportPath(file, importPath);

    // There should be a better way
    var importedModuleFile = t.clone(file);
    importedModuleFile.opts = t.cloneDeep(file.opts);
    importedModuleFile.opts.filename = importedModuleFile.opts.filenameRelative = importedModulePath + '.js';
    
    importedModuleFile.opts.moduleIds = true;
    var result = importedModuleFile.getModuleName();
    return result;
  }

  function SystemImportExpressionTransformer(state, params) {
    this.state = state;
    this.file = state.file;
    this.pluginOptions = this.state.opts;
    this.moduleType = this.pluginOptions.modules;
    var param = params[0];
    this.importedModuleLiteral = t.stringLiteral(param.node.value);

    var moduleName = getImportModuleName(this.file, this.importedModuleLiteral.value);
    this.moduleNameLiteral = t.stringLiteral(moduleName);
  }

  SystemImportExpressionTransformer.prototype.getGlobalIdentifier = function () {
    if (this.globalIdentifier) {
      return this.globalIdentifier;
    }

    var name = 'system-import-transformer-global-identifier';
    var ref = t.conditionalExpression(
      t.binaryExpression('!==',
        t.unaryExpression('typeof', t.identifier('window')),
        t.stringLiteral('undefined')
      ),
      t.identifier('window'),
      t.identifier('self')
    );
    this.globalIdentifier = this.getOrCreateHelper(name, ref);
    return this.globalIdentifier;
  };

  SystemImportExpressionTransformer.prototype.getOrCreateHelper = function (name, ref) {
    var declar = this.file.declarations[name];
    if (declar) {
      return declar;
    }

    var uid = this.file.declarations[name] = this.file.scope.generateUidIdentifier(name);
    this.file.usedHelpers[name] = true;

    if (t.isFunctionExpression(ref) && !ref.id) {
        ref.body._compact = true;
        ref._generated = true;
        ref.id = uid;
        ref.type = "FunctionDeclaration";
        this.file.attachAuxiliaryComment(ref);
        this.file.path.unshiftContainer("body", ref);
    } else {
        ref._compact = true;
        this.file.scope.push({
            id: uid,
            init: ref,
            unique: true
        });
    }

    return uid;
  };

  SystemImportExpressionTransformer.prototype.getAmdTest = function () {
    var globalIdentifier = this.getGlobalIdentifier();
    // typeof global.define === 'function' && global.define.amd
    var amdTest = t.logicalExpression('&&',
      t.binaryExpression('===',
        t.unaryExpression('typeof', t.memberExpression(
          globalIdentifier,
          t.identifier('define')
        )),
        t.stringLiteral('function')
      ),
      t.memberExpression(
        t.memberExpression(
          globalIdentifier,
          t.identifier('define')
        ),
        t.identifier('amd')
      )
    );
    return amdTest;
  };

  SystemImportExpressionTransformer.prototype.getAmdRequire = function (module) {
    var globalIdentifier = this.getGlobalIdentifier();
    // global.require(['localforageSerializer'], resolve, reject);
    var amdRequire = t.expressionStatement(
      t.callExpression(
        t.memberExpression(
          globalIdentifier,
          t.identifier('require')
        ),
        [
          t.arrayExpression([module]),
          t.identifier('resolve'),
          t.identifier('reject')
        ]
      )
    );
    return amdRequire;
  };

  SystemImportExpressionTransformer.prototype.getCommonJSTest = function () {
    // typeof module !== 'undefined' && module.exports && typeof require !== 'undefined'
    var commonJSTest = t.logicalExpression('&&',
      t.binaryExpression('!==',
        t.unaryExpression('typeof', t.identifier('module')),
        t.stringLiteral('undefined')
      ),
      t.logicalExpression('&&',
        t.memberExpression(
          t.identifier('module'),
          t.identifier('exports')
        ),
        t.binaryExpression('!==',
          t.unaryExpression('typeof', t.identifier('require')),
          t.stringLiteral('undefined')
        )
      )
    );
    return commonJSTest;
  };

  SystemImportExpressionTransformer.prototype.getComponentTest = function () {
    var globalIdentifier = this.getGlobalIdentifier();
    // typeof module !== 'undefined' && module.component && global.require && global.require.loader === 'component'
    var componentTest = t.logicalExpression('&&',
      t.binaryExpression('!==',
        t.unaryExpression('typeof', t.identifier('module')),
        t.stringLiteral('undefined')
      ),
      t.logicalExpression('&&',
        t.memberExpression(
          t.identifier('module'),
          t.identifier('component')
        ),
        t.logicalExpression('&&',
          t.memberExpression(
            globalIdentifier,
            t.identifier('require')
          ),
          t.binaryExpression('===',
            t.memberExpression(
              t.memberExpression(
                globalIdentifier,
                t.identifier('require')
              ),
              t.identifier('loader')
            ),
            t.stringLiteral('component')
          )
        )
      )
    );
    return componentTest;
  };

  SystemImportExpressionTransformer.prototype.getCommonJSRequire = function (module) {
    // resolve(require('./../utils/serializer'));
    
    var commonJSRequireExpression = t.callExpression(
      t.identifier('require'),
      // [module] // why this isn't working???
      // [module, t.identifier('undefined')] // had to add extra undefined parameter or parenthesis !?!?!?
      [t.parenthesizedExpression(module)]
    );
    var commonJSRequire = this.createResolveExpressionStatement(commonJSRequireExpression);
    return commonJSRequire;
  };

  SystemImportExpressionTransformer.prototype.getGlobalRequire = function (module) {
    var globalIdentifier = this.getGlobalIdentifier();

    // resolve(global.localforageSerializer);
    var globalMemberExpression = t.memberExpression(
      globalIdentifier,
      module,
      true // computed
    );
    var globalRequire = this.createResolveExpressionStatement(globalMemberExpression);
    return globalRequire;
  };

  SystemImportExpressionTransformer.prototype.createTransformedExpression = function () {
    var moduleImportExpressions;
    if (this.moduleType === 'amd') {
      moduleImportExpressions = [this.getAmdRequire(this.moduleNameLiteral)];
    } else if (this.moduleType === 'common') {
      moduleImportExpressions = [this.getCommonJSRequire(this.importedModuleLiteral)];
    } else {
      var amdTest = this.getAmdTest();
      var commonJSTest = this.getCommonJSTest();
      var componentTest = this.getComponentTest();
      var commonJSOrComponentTest = t.logicalExpression('||', commonJSTest, componentTest);

      var umdRequire = t.ifStatement(amdTest,
        t.blockStatement([this.getAmdRequire(this.moduleNameLiteral)]),
        t.ifStatement(commonJSOrComponentTest,
          t.blockStatement([this.getCommonJSRequire(this.importedModuleLiteral)]),
          t.blockStatement([this.getGlobalRequire(this.moduleNameLiteral)])
        )
      );
      moduleImportExpressions = [umdRequire];
    }

    var newPromiseExpression = t.newExpression(t.identifier('Promise'), [
      t.functionExpression(null,
        [t.identifier('resolve'), t.identifier('reject')],
        t.blockStatement(moduleImportExpressions)
      )
    ]);
    return newPromiseExpression;
  };

  SystemImportExpressionTransformer.prototype.createResolveExpressionStatement = function (parameter) {
    var result = t.expressionStatement(
      t.callExpression(
        t.identifier('resolve'), [parameter]
      )
    );
    return result;
  };

  return {
    visitor: {
      CallExpression: function (path, state) {
        var callee = path.get('callee');
        if (callee && callee.matchesPattern('System.import')) {
          var params = path.get('arguments');
          if (params.length && params[0].isLiteral()) {
            var transformer = new SystemImportExpressionTransformer(state, params);
            var transformedExpression = transformer.createTransformedExpression();
            if (transformedExpression) {
              path.replaceWith(transformedExpression);
            }
          }
        }
      }
    }
  };
};

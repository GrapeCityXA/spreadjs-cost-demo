const { parse } = require('acorn');

function functionClass(code) {
  if (typeof code !== 'string' || !code.trim() || code.length > 50000) throw Error('代码不能为空且不能超过 50,000 字符');
  const program = parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
  const path = node => node?.type === 'Identifier' ? node.name : node?.type === 'MemberExpression' && !node.computed ? `${path(node.object)}.${node.property.name}` : '';
  const classes = program.body.filter(node => node.type === 'ClassDeclaration' && path(node.superClass) === 'GC.Spread.CalcEngine.Functions.Function');
  if (classes.length !== 1) throw Error('请声明且只声明一个继承 GC.Spread.CalcEngine.Functions.Function 的 class');
  return classes[0];
}

const memberName = node => !node.static && !node.computed ? node.key?.name || node.key?.value : null;
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

function identityNodes(code) {
  const declaration = functionClass(code), members = declaration.body.body;
  const constructor = members.find(node => memberName(node) === 'constructor');
  const names = [], types = [];
  walk(constructor, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'Super') names.push(node.arguments[0]);
    if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'MemberExpression' && !node.left.computed && node.left.object.type === 'ThisExpression' && node.left.property.name === 'typeName') types.push(node.right);
  });
  for (const node of members) if (node.type === 'PropertyDefinition' && memberName(node) === 'typeName') types.push(node.value);
  return { declaration, nameNode: names.length === 1 ? names[0] : null, typeNode: types.length === 1 ? types[0] : null };
}

function readFunctionIdentity(code, strict = false) {
  const { declaration, nameNode, typeNode } = identityNodes(code);
  const literal = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value : '';
  const identity = { className: declaration.id.name, functionName: literal(nameNode).toUpperCase(), typeName: literal(typeNode) };
  if (strict) {
    if (!/^[A-Za-z_$][\w$]{0,63}$/.test(identity.className) || identity.className === 'GC') throw Error('class 名须为 1–64 位有效英文标识符，不能使用 GC');
    if (!/^[A-Z_][A-Z0-9_.]{1,63}$/.test(identity.functionName)) throw Error('请在 super() 中填写固定的函数名：2–64 位英文、数字、下划线或点');
    if (!/^[A-Za-z_][\w.]{1,159}$/.test(identity.typeName)) throw Error('请在构造函数或类属性中填写固定的 typeName，例如 CustomFunctions.MyFunction');
  }
  return { ...identity, methods: declaration.body.body.map(memberName).filter(Boolean) };
}

// Parse JavaScript syntax only. Never evaluate source in the server process.
function readEvaluateSignature(code) {
  const declaration = functionClass(code);
  const method = declaration?.body.body.find(node => !node.static && (node.key?.name === 'evaluate' || node.key?.value === 'evaluate') && ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.value?.type));
  if (!method) throw new Error('请在函数类中声明 evaluate(...) 方法，以便识别参数');
  if (method.value.async || method.value.generator) throw new Error('试算仅支持同步 evaluate() 方法');
  return { className: declaration.id.name, parameters: method.value.params.map(param => ({
    label: code.slice(param.start, param.end).slice(0, 200),
    optional: param.type === 'AssignmentPattern',
    rest: param.type === 'RestElement',
  })) };
}

// Upgrade an old local draft without replacing evaluate or existing serializers.
function addSerialization(code) {
  if (typeof code !== 'string' || code.length > 50000) throw Error('函数代码过大或无效');
  const declaration = functionClass(code);
  const members = declaration.body.body;
  const named = name => members.find(node => !node.static && (node.key?.name === name || node.key?.value === name));
  const properties = new Set(['typeName', 'name', 'minArgs', 'maxArgs']);
  let hasTypeName = Boolean(named('typeName'));
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    const target = node.type === 'AssignmentExpression' ? node.left : null;
    if (target?.type === 'MemberExpression' && target.object?.type === 'ThisExpression' && !target.computed) {
      const name = target.property.name;
      if (/^[A-Za-z_$][\w$]*$/.test(name)) properties.add(name);
      if (name === 'typeName') hasTypeName = true;
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
  }
  visit(named('constructor'));
  for (const node of members) if (node.type === 'PropertyDefinition' && !node.static && !node.computed && node.key.type === 'Identifier') properties.add(node.key.name);
  const additions = [];
  if (!hasTypeName) additions.push(`  typeName = "CustomFunctions.${declaration.id.name}";`);
  if (!named('toJSON')) additions.push(`  toJSON() {\n    return { ${[...properties].map(name => `${name}: this.${name}`).join(', ')} };\n  }`);
  if (!named('fromJSON')) additions.push(`  fromJSON(settings) {\n${[...properties].filter(name => name !== 'typeName').map(name => `    if (Object.hasOwn(settings, "${name}")) this.${name} = settings.${name};`).join('\n')}\n  }`);
  const position = declaration.body.end - 1;
  return additions.length ? code.slice(0, position) + '\n' + additions.join('\n\n') + '\n' + code.slice(position) : code;
}

// Only patch AST ranges. Never regenerate or execute the author's business logic.
function editFunctionSource(code, { className, functionName, method } = {}) {
  const { declaration, nameNode, typeNode } = identityNodes(code);
  const edits = [];
  if (className !== undefined || functionName !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(className) || className === 'GC') throw Error('class 名须以英文字母或下划线开头，最多 64 位，不能使用 GC');
    parse(`"use strict"; class ${className} {}`, { ecmaVersion: 'latest' });
    if (!/^[A-Z_][A-Z0-9_.]{1,63}$/.test(functionName)) throw Error('函数名须为 2–64 位大写英文、数字、下划线或点');
    if (nameNode?.type !== 'Literal' || typeNode?.type !== 'Literal') throw Error('当前名称由代码动态生成，请直接在代码中修改名称');
    if (className !== declaration.id.name) {
      let referenced = false;
      walk(declaration.body, node => { if (node.type === 'Identifier' && node.name === declaration.id.name) referenced = true; });
      if (referenced) throw Error('代码中引用了当前 class 名，请在代码编辑器中同步重命名这些引用');
      edits.push([declaration.id.start, declaration.id.end, className]);
      edits.push([typeNode.start, typeNode.end, JSON.stringify(`CustomFunctions.${className}`)]);
    }
    edits.push([nameNode.start, nameNode.end, JSON.stringify(functionName)]);
  }
  if (method) {
    const methods = readFunctionIdentity(code).methods;
    if (methods.includes(method)) throw Error(`${method} 已存在，无需重复添加`);
    const params = readEvaluateSignature(code).parameters;
    const snippets = {
      description: `description() {\n    return {\n      description: "自定义函数说明",\n      parameters: ${JSON.stringify(params.map(p => ({ name: p.label, optional: p.optional, repeatable: p.rest })))}\n    };\n  }`,
      acceptsArray: 'acceptsArray(argIndex) {\n    // 参数索引从 0 开始；按需改为 true。\n    return false;\n  }',
      acceptsReference: 'acceptsReference(argIndex) {\n    // 仅用于试算；当前平台发布不支持引用对象。\n    return false;\n  }',
      acceptsError: 'acceptsError(argIndex) {\n    // 改为 true 后，请在 evaluate 中处理错误值。\n    return false;\n  }',
      acceptsMissingArgument: 'acceptsMissingArgument(argIndex) {\n    // 改为 true 后，请在 evaluate 中处理缺失参数。\n    return false;\n  }',
      isVolatile: 'isVolatile() {\n    // true：任意单元格变化时重新计算。\n    return false;\n  }',
      isContextSensitive: 'isContextSensitive() {\n    // true 时 evaluate 的第一个参数为 context；当前仅支持试算。\n    return false;\n  }',
      supportCalcWorker: 'supportCalcWorker() {\n    // 当前平台未启用 Calc Worker。开启前需确认插件、配置及代码限制。\n    return false;\n  }',
    };
    if (!Object.hasOwn(snippets, method)) throw Error('不支持添加此方法');
    edits.push([declaration.body.end - 1, declaration.body.end - 1, `\n  ${snippets[method]}\n`]);
  }
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) code = code.slice(0, start) + value + code.slice(end);
  return { code, ...readFunctionIdentity(code) };
}

module.exports = { readEvaluateSignature, addSerialization, readFunctionIdentity, editFunctionSource };

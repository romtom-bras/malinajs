
import acorn from 'acorn';
import astring from 'astring';
import { assert, detectExpressionType, xNode } from './utils.js'


export function parse() {
    let source = this.scriptNodes.length ? this.scriptNodes[0].content : null;
    this.script = {
        source,
        watchers: [],
        imports: [],
        importedNames: [],
        props: [],
        rootVariables: {},
        rootFunctions: {}
    };
    if(source) {
        source = source.split(/\n/).map(line => {
            let rx = line.match(/^(\s*)\/\/(.*)$/);
            if(!rx) return line;
            let code = rx[2].trim()
            if(code != '!no-check') return line;
            return rx[1] + '$$_noCheck;';
        }).join('\n');
        this.script.ast = acorn.parse(source, {sourceType: 'module', ecmaVersion: 12});

        if(source.includes('$props')) this.require('$props');
        if(source.includes('$attributes')) this.require('$attributes');
        if(source.includes('$emit')) this.require('$emit');
        if(source.includes('$onDestroy')) this.require('$onDestroy');
        if(source.includes('$onMount')) this.require('$onMount');
        if(source.includes('$context')) this.require('$context');
    } else {
        this.script.ast = {
            body: [],
            sourceType: "module",
            type: "Program"
        };
    }
};

export function transform() {
    const result = this.script;
    const source = this.script.source;
    const ast = this.script.ast;

    let rootVariables = result.rootVariables;
    let rootFunctions = result.rootFunctions;
    ast.body.forEach(n => {
        if(n.type == 'FunctionDeclaration') {
            rootFunctions[n.id.name] = true;
        } else if(n.type == 'VariableDeclaration') {
            n.declarations.forEach(i => {
                rootVariables[i.id.name] = true;
                if(i.init && i.init.type == 'ArrowFunctionExpression') rootFunctions[i.id.name] = true;
            });
        }
    });

    result.onMount = rootFunctions.onMount;
    result.onDestroy = rootFunctions.onDestroy;

    const funcTypes = {
        FunctionDeclaration: 1,
        FunctionExpression: 1,
        ArrowFunctionExpression: 1
    }

    const applyBlock = () => {
        this.require('apply');
        return {
            _apply: true,
            type: 'ExpressionStatement',
            expression: {
                callee: {
                    type: 'Identifier',
                    name: '$$apply'
                },
                type: 'CallExpression'
            }
        }
    }

    const returnApplyBlock = (a) => {
        this.require('apply');
        return {
            _apply: true,
            callee: {
                type: 'Identifier',
                name: '$$apply'
            },
            type: 'CallExpression',
            arguments: [a]
        }
    }

    function isInLoop(node) {
        if(!node._parent || node._parent.type != 'CallExpression') return false;
        if(node._parent.callee.type != 'MemberExpression') return false;
        let method = node._parent.callee.property.name;
        return method == 'forEach' || method == 'map' || method == 'filter';
    }

    function isNoCheck(node) {
        return node.type == 'ExpressionStatement' && node.expression.type == 'Identifier' && node.expression.name == '$$_noCheck';
    };

    function transformNode(node) {
        if(funcTypes[node.type] && node.body.body && node.body.body.length) {
            if(node._parent.type == 'CallExpression' && node._parent.callee.name == '$onDestroy') return 'stop';
            for(let i=0; i<node.body.body.length; i++) {
                let n = node.body.body[i];
                if(!isNoCheck(n)) continue;
                node.body.body.splice(i, 1);
                return 'stop';
            }
            if(node._parent.type == 'CallExpression' && node._parent.callee.name == '$onMount') return;
            if(!isInLoop(node)) {
                node.body.body.unshift(applyBlock());
            }
        } else if(node.type == 'ArrowFunctionExpression') {
            if(node._parent.type == 'CallExpression' && node._parent.callee.name == '$onDestroy') return 'stop';
            if(node._parent.type == 'CallExpression' && node._parent.callee.name == '$onMount') return;
            if(node.body.type != 'BlockStatement' && !isInLoop(node)) {
                node.body = {
                    type: 'BlockStatement',
                    body: [{
                        type: 'ReturnStatement',
                        argument: node.body
                    }]
                };
                transformNode(node);
            }
        } else if(node.type == 'AwaitExpression') {
            let n = node, p;
            while(n._parent) {
                p = n._parent;
                if(p.type == 'BlockStatement') break;
                n = p;
                p = null;
            }
            if(p) {
                let i = p.body.indexOf(n);
                if(i >= 0 && !(p.body[i + 1] && p.body[i + 1]._apply)) {
                    if(n.type == 'ReturnStatement') {
                        n.argument = returnApplyBlock(n.argument);
                    } else {
                        p.body.splice(i + 1, 0, applyBlock());
                    }
                }
            }
        }
    };

    function walk(node, parent, fn) {
        if(typeof node !== 'object') return;

        if(node._apply) return;
        node._parent = parent;
        let forParent = parent;
        if(node.type) {
            if(fn(node) == 'stop') return;
            forParent = node;
        }
        for(let key in node) {
            let child = node[key];
            if(key == '_parent') continue;
            if(!child || typeof child !== 'object') continue;

            if(Array.isArray(child)) {
                for(let i=0;i<child.length;i++) {
                    walk(child[i], forParent, fn);
                }
            } else {
                walk(child, forParent, fn);
            }
        }
    };
    walk(ast, null, transformNode);

    function makeVariable(name) {
        return {
            "type": "VariableDeclaration",
            "declarations": [{
                "type": "VariableDeclarator",
                "id": {
                    "type": "Identifier",
                    "name": name
                },
                "init": null
            }],
            "kind": "var"
        }
    }

    function makeWatch(n) {
        function assertExpression(n) {
            if(n.type == 'Identifier') return;
            if(n.type.endsWith('Expression')) return;
            throw 'Wrong expression';
        };

        if(n.body.type != 'ExpressionStatement') throw 'Error';
        if(n.body.expression.type == 'AssignmentExpression') {
            const ex = n.body.expression;
            if(ex.operator != '=') throw 'Error';
            let target;
            if(ex.left.type == 'Identifier') {
                target = ex.left.name;
                if(!(target in rootVariables)) resultBody.push(makeVariable(target));
            } else if(ex.left.type == 'MemberExpression') {
                target = source.substring(ex.left.start, ex.left.end);
            } else throw 'Error';
            assertExpression(ex.right);
            const exp = source.substring(ex.right.start, ex.right.end);
            result.watchers.push(`$cd.prefix.push(() => {${target} = ${exp};});`);
        } else if(n.body.expression.type == 'SequenceExpression') {
            const ex = n.body.expression.expressions;
            const handler = ex[ex.length - 1];
            let callback = source.substring(handler.start, handler.end);
            if(handler.type == 'ArrowFunctionExpression' || handler.type == 'FunctionExpression') {
                // default
            } else if(detectExpressionType(callback) == 'identifier') {
                callback = `(v) => { ${callback}(v); }`;
            } else {
                callback = `() => { ${callback}; }`;
            }

            if(ex.length == 2) {
                assertExpression(ex[0]);
                let exp = source.substring(ex[0].start, ex[0].end);
                result.watchers.push(`$watch($cd, () => (${exp}), ${callback}, {cmp: $runtime.$$deepComparator(0)});`);
            } else if(ex.length > 2) {
                for(let i = 0;i<ex.length-1;i++) assertExpression(ex[i]);
                let exp = source.substring(ex[0].start, ex[ex.length-2].end);
                result.watchers.push(`$watch($cd, () => [${exp}], ($args) => { (${callback}).apply(null, $args); }, {cmp: $runtime.$$deepComparator(1)});`);
            } else throw 'Error';
        } else throw 'Error';
    }

    let imports = [];
    let resultBody = [];
    let lastPropIndex = null;

    ast.body.forEach(n => {
        if(n.type == 'ImportDeclaration') {
            imports.push(n);
            n.specifiers.forEach(s => {
                if(s.local.type != 'Identifier') return;
                result.importedNames.push(s.local.name);
                if(s.type != 'ImportDefaultSpecifier') return;
                result.imports.push(s.local.name);
            });
            return;
        } else if(n.type == 'ExportNamedDeclaration') {
            assert(n.declaration.type == 'VariableDeclaration', 'Wrong export');
            n.declaration.declarations.forEach(d => {
                assert(d.type == 'VariableDeclarator', 'Wrong export');
                result.props.push(d.id.name);
                resultBody.push({
                    type: 'VariableDeclaration',
                    kind: 'let',
                    declarations: [{
                        type: 'VariableDeclarator',
                        id: {
                            type: 'ObjectPattern',
                            properties: [{
                                type: 'Property',
                                method: false,
                                shorthand: true,
                                computed: false,
                                kind: 'init',
                                key: d.id,
                                value: d.init ? {
                                    type: 'AssignmentPattern',
                                    left: d.id,
                                    right: d.init
                                } : d.id
                            }]
                        },
                        init: {type: 'Identifier', name: '$props'}
                    }]
                });
                this.require('$props');
                lastPropIndex = resultBody.length;
            });
            return;
        }

        if(n.type == 'LabeledStatement' && n.label.name == '$') {
            try {
                makeWatch(n);
                return;
            } catch (e) {
                throw new Error(e + ': ' + source.substring(n.start, n.end));
            }
        }
        resultBody.push(n);
    });

    let header = [];
    if(lastPropIndex != null) {
        header.push(rawNode(() => {
            if(this.inuse.$props) return 'const $props = $option.props;';
        }));

        resultBody.splice(lastPropIndex, 0, rawNode(() => {
            let code = [];
            if(this.inuse.$attributes) {
                code.push(`let $$skipAttrs = {${result.props.map(n => n + ':1').join(',')}};`);
                code.push('let $attributes = $runtime.recalcAttributes($props, $$skipAttrs);');
                code.push(`$runtime.completeProps($component, () => {`);
                code.push(`  ({${result.props.join(',')}} = $props);`);
                code.push('  $attributes = $runtime.recalcAttributes($props, $$skipAttrs);');
                code.push(`}, {${result.props.map(n => n + ': () => '+n).join(',')}});`);
            } else if(this.inuse.$props) {
                code.push(`$runtime.completeProps($component, () => {`);
                code.push(`  ({${result.props.join(',')}} = $props);`);
                code.push(`}, {${result.props.map(n => n + ': () => '+n).join(',')}});`);
            }
            return code;
        }));
    } else {
        header.push(rawNode(() => {
            if(this.inuse.$props) return 'const $props = $option.props;';
        }));
        header.push(rawNode(() => {
            if(this.inuse.$attributes) return 'let $attributes = $props;';
        }));
    }

    header.push(rawNode(() => {
        if(this.inuse.$context) return 'const $context = $component.context;';
    }));


    imports.push(rawNode(() => {
        if(this.inuse.$onMount) return `import {$onMount} from 'malinajs/runtime.js';`;
    }));

    header.push(rawNode(() => {
        if(this.inuse.$onDestroy) return `const $onDestroy = fn => $component._d.push(fn);`;
    }));

    if(this.config.autoSubscribe) {
        result.importedNames.forEach(name => {
            header.push(rawNode(`$runtime.autoSubscribe($component, ${name});`));
        });
    }

    if(!rootFunctions.$emit) {
        header.push(rawNode(() => {
            if(this.inuse.$emit) return 'const $emit = $runtime.$makeEmitter($option);';
        }));
    }

    if(this.scriptNodes[0] && this.scriptNodes[0].attributes.some(a => a.name == 'property')) {
        result.props.forEach(name => {
            resultBody.push(rawNode(`$runtime.makeExternalProperty($component, '${name}', () => ${name}, _${name} => ${name} = _${name});`));
        });
    }

    this.script.rootLevel = resultBody;

    this.module.top.push(xNode('ast', {body: imports}));
    this.module.head.push(xNode('ast', {body: header}));
    this.module.code.push(xNode('ast', {body: resultBody}));
};

export function build() {
    const generator = Object.assign({
        ImportExpression: function(node, state) {
            state.write('import(');
            this[node.source.type](node.source, state);
            state.write(')');
        },
        Raw: function(node, state) {
            state.write(node.value);
        }
    }, astring.baseGenerator);
    this.script.code = astring.generate(this.script.ast, {generator});
}


function rawNode(exp, n) {
    n = n || {};
    n.type = 'Raw';
    n.value = exp;
    return n;
}


const generator = Object.assign({
    ImportExpression: function(node, state) {
        state.write('import(');
        this[node.source.type](node.source, state);
        state.write(')');
    },
    Raw: function(node, state) {
        let value = typeof node.value == 'function' ? node.value() : node.value;
        if(value) {
            var indent = state.indent.repeat(state.indentLevel);
            if(!Array.isArray(value)) value = [value];
            value.forEach(v => {
                state.write(indent + v + state.lineEnd);
            })
        }
    },
    CustomBlock: function(node, state) {
        var indent = state.indent.repeat(state.indentLevel);
        var lineEnd = state.lineEnd;

        var statements = node.body;
        var length = statements.length;

        for (var i = 0; i < length; i++) {
            var statement = statements[i];

            if(statement.type != 'Raw') state.write(indent);
            this[statement.type](statement, state);
            if(statement.type != 'Raw') state.write(lineEnd);
        }
    }
}, astring.baseGenerator);


xNode.init.ast = (ctx, node) => {
    if(!node.body.length) return;
    let code = astring.generate({
        type: 'CustomBlock',
        body: node.body
    }, {generator, startingIndentLevel: ctx.indent});
    ctx.write(code);
}

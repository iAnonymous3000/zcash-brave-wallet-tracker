"""Reference reader for gate3's SWAP_DISABLED_CHAINS, built on Python's own parser.

Used only by tests/gate3-python-oracle.test.ts as an oracle for the hand-written reader in
src/ingest/sources/services.ts (parseGate3Switch). It never runs the module: the source is parsed with ast.parse and
the tree is compiled with compile() only to learn whether CPython accepts it (errors ast.parse does not report, such
as a misplaced __future__ import, a module-level nonlocal or a duplicate parameter, are raised there). The code
object is discarded; nothing is executed or evaluated.

Usage (Python 3.9 or later):
  python3 -I gate3_oracle.py < constants.py      one module on stdin (raw bytes) -> one JSON object on stdout
  python3 -I gate3_oracle.py --batch < in.txt    one base64-encoded module per input line -> one JSON object per line

Output: {"zcashDisabled": true | false | null, "reason": str | null}

null (unknown) when
  - the module does not parse or compile on this Python;
  - SWAP_DISABLED_CHAINS is bound by anything other than exactly one top-level statement
        SWAP_DISABLED_CHAINS = <literal>    or    SWAP_DISABLED_CHAINS: <annotation> = <literal>
    directly in the module body. The annotated form is accepted for that one definition because the real gate3 file
    uses it; any other annotated or augmented assignment of the name (a bare `SWAP_DISABLED_CHAINS: T` included, as
    its target is a Store-context name) is a second binding. Counted as bindings: every Store/Del-context name at
    module scope (nested if/for/while/try/with/match blocks included), unpacking/chained/for/with targets, del,
    def/class names, import and import-as names, except-as names, match captures, type aliases and type parameters
    (3.12+), any walrus, global or nonlocal naming it in any scope, and any star import (it may bind any name);
  - the module uses a dynamic route to module globals: a call to setattr, delattr, globals, vars, locals, exec, eval
    or __import__ (as a bare name or as an attribute), any `.modules`, `.__dict__`, `.__globals__`, `.f_globals`,
    `.f_locals` or `__builtins__`, an attribute store/delete named SWAP_DISABLED_CHAINS on any object, or an item
    store/delete keyed by the string "SWAP_DISABLED_CHAINS";
  - the switch itself is changed in place: a method call on it other than the read-only ones, or an item/attribute
    store or delete on it;
  - frozenset (when the definition calls it) is bound anywhere at module scope, or stored as an attribute
    (builtins.frozenset = ...);
  - the value is not a literal tuple/list/set display, frozenset() or frozenset(<such a display>) whose elements are
    all Chain.X attribute reads.
Otherwise true iff one element is Chain.ZCASH (attribute names compared after Python's NFKC normalisation, as the
parser does).

Bindings inside function, lambda, class and comprehension scopes are local to those scopes and do not count, except
through global/nonlocal/walrus, which always count.
"""

import ast
import base64
import json
import sys
import warnings

NAME = "SWAP_DISABLED_CHAINS"
DYNAMIC_CALLS = {"setattr", "delattr", "globals", "vars", "locals", "exec", "eval", "__import__"}
DYNAMIC_ATTRS = {"modules", "__dict__", "__globals__", "f_globals", "f_locals", "__builtins__"}
READ_ONLY_METHODS = {"union", "intersection", "difference", "symmetric_difference", "issubset", "issuperset", "isdisjoint", "copy", "count", "index"}
SCOPE_NODES_FUNCTION = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
SCOPE_NODES_COMPREHENSION = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)


def _node_types(*names):
    """AST classes by name, skipping those this Python does not have (match is 3.10+, TypeAlias 3.12+)."""
    return tuple(getattr(ast, n) for n in names if hasattr(ast, n))


MATCH_CAPTURES = _node_types("MatchAs", "MatchStar")
MATCH_MAPPING = _node_types("MatchMapping")
TYPE_PARAMS = _node_types("TypeVar", "ParamSpec", "TypeVarTuple")


def unknown(reason):
    return {"zcashDisabled": None, "reason": reason}


def where(node):
    line = getattr(node, "lineno", None)
    return "line %s" % line if line is not None else "somewhere"


def walk(tree):
    """Yield (node, scope) for every node; scope is 'module', 'class', 'function' or 'comprehension'. Iterative."""
    stack = [(tree, "module")]
    while stack:
        node, scope = stack.pop()
        yield node, scope
        if isinstance(node, SCOPE_NODES_FUNCTION):
            inner = "function"
        elif isinstance(node, ast.ClassDef):
            inner = "class"
        elif isinstance(node, SCOPE_NODES_COMPREHENSION):
            inner = "comprehension"
        else:
            inner = scope
        children = list(ast.iter_child_nodes(node))
        for child in reversed(children):
            stack.append((child, inner))


def chain_member(elt):
    """'X' for an element that is exactly the attribute read Chain.X, else None."""
    if isinstance(elt, ast.Attribute) and isinstance(elt.value, ast.Name) and elt.value.id == "Chain" and isinstance(elt.ctx, ast.Load):
        return elt.attr
    return None


def literal_members(value):
    """Member names of a literal tuple/list/set display, frozenset() or frozenset(<display>); None if not such a literal."""
    if isinstance(value, ast.Call):
        if not (isinstance(value.func, ast.Name) and value.func.id == "frozenset") or value.keywords:
            return None
        if not value.args:
            return []
        if len(value.args) != 1:
            return None
        value = value.args[0]
    if not isinstance(value, (ast.Tuple, ast.List, ast.Set)):
        return None
    members = [chain_member(e) for e in value.elts]
    if any(m is None for m in members):
        return None
    return members


def is_definition(stmt):
    """A top-level `NAME = v` (one plain target) or `NAME: T = v` (simple target, with a value)."""
    if isinstance(stmt, ast.Assign):
        return len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name) and stmt.targets[0].id == NAME
    if isinstance(stmt, ast.AnnAssign):
        return isinstance(stmt.target, ast.Name) and stmt.target.id == NAME and stmt.simple == 1 and stmt.value is not None
    return False


def target_kinds(tree):
    """Describe each Store/Del-context Name by the statement form that binds it (for the reasons only)."""
    kinds = {}

    def mark(target, how):
        for n in ast.walk(target):
            if isinstance(n, ast.Name):
                kinds.setdefault(id(n), how)

    for node in ast.walk(tree):
        if isinstance(node, ast.AnnAssign):
            mark(node.target, "an annotated assignment" if node.value is not None else "a bare annotation (it has a Store-context target)")
        elif isinstance(node, ast.AugAssign):
            mark(node.target, "an augmented assignment")
        elif isinstance(node, ast.Delete):
            for t in node.targets:
                mark(t, "del")
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            mark(node.target, "a for target")
        elif isinstance(node, ast.withitem) and node.optional_vars is not None:
            mark(node.optional_vars, "a with ... as target")
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if len(node.targets) > 1:
                    mark(t, "a chained assignment")
                elif not isinstance(t, ast.Name):
                    mark(t, "an unpacking target")
        elif type(node).__name__ == "TypeAlias":
            mark(node.name, "a type alias")
    return kinds


def analyse(data):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            tree = ast.parse(data, filename="constants.py", mode="exec")
            # Validation only: the code object is dropped at once and never executed.
            compile(tree, "constants.py", "exec", dont_inherit=True)
    except BaseException as e:  # SyntaxError, ValueError (NUL), UnicodeDecodeError, RecursionError, MemoryError, ...
        if isinstance(e, KeyboardInterrupt):
            raise
        return unknown("the module does not parse or compile on Python %d.%d (%s: %s)" % (sys.version_info[0], sys.version_info[1], type(e).__name__, str(e)[:200]))

    definitions = [s for s in tree.body if is_definition(s)]
    module_bindings = []  # (node, how) for the switch at module scope, the definitions included
    frozenset_bound = None
    how_by_target = target_kinds(tree)

    def bind(node, scope, name, how):
        nonlocal frozenset_bound
        if scope != "module":
            return
        if name == NAME:
            module_bindings.append((node, how))
        elif name == "frozenset" and frozenset_bound is None:
            frozenset_bound = node

    for node, scope in walk(tree):
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                bind(node, scope, node.id, how_by_target.get(id(node), "an assignment"))
            if node.id == "__builtins__":
                return unknown("%s: uses __builtins__" % where(node))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bind(node, scope, node.name, "a def or class statement")
        elif isinstance(node, ast.alias):
            if node.name == "*":
                return unknown("a star import (it may bind any name, %s included)" % NAME)
            bound = node.asname if node.asname else node.name.split(".")[0]
            bind(node, scope, bound, "an import")
        elif isinstance(node, ast.ExceptHandler):
            if node.name:
                bind(node, scope, node.name, "an except ... as target")
        elif MATCH_CAPTURES and isinstance(node, MATCH_CAPTURES):
            if node.name:
                bind(node, scope, node.name, "a match capture")
        elif MATCH_MAPPING and isinstance(node, MATCH_MAPPING):
            if node.rest:
                bind(node, scope, node.rest, "a match capture")
        elif TYPE_PARAMS and isinstance(node, TYPE_PARAMS):
            if node.name == NAME:
                return unknown("%s: a type parameter named %s" % (where(node), NAME))
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            if NAME in node.names:
                return unknown("%s: a global/nonlocal declaration of %s" % (where(node), NAME))
        elif isinstance(node, ast.NamedExpr):
            if isinstance(node.target, ast.Name) and node.target.id == NAME:
                return unknown("%s: a walrus assignment to %s" % (where(node), NAME))
        elif isinstance(node, ast.Call):
            f = node.func
            called = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else None
            if called in DYNAMIC_CALLS:
                return unknown("%s: calls %s(), which can rebind module globals" % (where(node), called))
            if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == NAME and f.attr not in READ_ONLY_METHODS:
                return unknown("%s: calls %s.%s(), which may change it in place" % (where(node), NAME, f.attr))
        elif isinstance(node, ast.Attribute):
            if node.attr in DYNAMIC_ATTRS:
                return unknown("%s: uses .%s, a route to module globals" % (where(node), node.attr))
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                if node.attr == NAME:
                    return unknown("%s: stores or deletes an attribute named %s" % (where(node), NAME))
                if node.attr == "frozenset" and frozenset_bound is None:
                    frozenset_bound = node
                if isinstance(node.value, ast.Name) and node.value.id == NAME:
                    return unknown("%s: stores or deletes an attribute of %s" % (where(node), NAME))
        elif isinstance(node, ast.Subscript):
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                if isinstance(node.slice, ast.Constant) and node.slice.value == NAME:
                    return unknown("%s: stores or deletes an item keyed %r" % (where(node), NAME))
                if isinstance(node.value, ast.Name) and node.value.id == NAME:
                    return unknown("%s: stores or deletes an item of %s" % (where(node), NAME))

    if not module_bindings:
        return unknown("%s is not bound at module level" % NAME)
    if len(definitions) != 1 or len(module_bindings) != 1:
        lines = ", ".join("%s: %s" % (where(n), how) for n, how in module_bindings)
        return unknown("%s is bound %d time(s) at module level (%s), not by exactly one plain top-level definition" % (NAME, len(module_bindings), lines))
    (definition,) = definitions
    value = definition.value
    if isinstance(value, ast.Call) and frozenset_bound is not None:
        return unknown("%s: frozenset is rebound at module level" % where(frozenset_bound))
    members = literal_members(value)
    if members is None:
        return unknown("line %d: the value of %s is not a literal tuple/list/set/frozenset(...) of Chain.X members" % (definition.lineno, NAME))
    return {"zcashDisabled": "ZCASH" in members, "reason": None}


def safe_analyse(data):
    try:
        return analyse(data)
    except RecursionError:
        return unknown("the syntax tree is too deep for this reader")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--batch":
        out = sys.stdout
        for line in sys.stdin.buffer:
            # Every input line is one module; an empty line is the empty module.
            out.write(json.dumps(safe_analyse(base64.b64decode(line.strip()))) + "\n")
            out.flush()
        return
    if len(sys.argv) > 1:
        sys.stderr.write("usage: gate3_oracle.py [--batch] < input\n")
        sys.exit(2)
    sys.stdout.write(json.dumps(safe_analyse(sys.stdin.buffer.read())) + "\n")


if __name__ == "__main__":
    main()

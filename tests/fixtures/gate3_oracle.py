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
    uses it (under the task's literal wording, which lists annotated assignment as unknown, the real file itself
    would read as unknown); any other annotated or augmented assignment of the name (a bare
    `SWAP_DISABLED_CHAINS: T` included, as its target is a Store-context name) is a second binding. Counted as
    bindings: every Store/Del-context name at module scope (nested if/for/while/try/with/match blocks included),
    unpacking/chained/for/with targets, del, def/class names, import and import-as names, except-as names, match
    captures, type aliases and type parameters (3.12+), any walrus, global or nonlocal naming it in any scope, and any
    star import (it may bind any name);
  - the module names a route to module globals or to running code, in any form - called, aliased (`g = globals`),
    read as an attribute, or imported and then used under its own name or an as-name (`from builtins import setattr
    as s; s(...)`): setattr, delattr, getattr, globals, vars, locals, exec, eval, compile, __import__, breakpoint,
    sys.modules, frames (_getframe/currentframe/f_globals/f_locals), operator.methodcaller/attrgetter, the inspect
    lookups (getattr_static/getmembers/getmodule), the import machinery (import_module, reload, exec_module,
    run_module, run_path), code objects (FunctionType, CodeType), annotation evaluators (get_type_hints,
    get_annotations) and logging's dictConfig/fileConfig; uses any name imported from a module that hands out
    builtins, frames or namespaces or runs code from data (builtins, gc, inspect, importlib, ctypes, pickle, marshal,
    shelve, copyreg, dill, cloudpickle, jsonpickle, yaml, code, codeop, runpy, timeit, cProfile, profile, pdb, bdb,
    trace, doctest, pydoc, pkgutil, unittest, mock; an import that is never used changes nothing); reads or writes any
    dunder attribute (__dict__, __globals__, __setattr__, __class__, __iadd__, __init__, ...) or uses __builtins__;
    stores or deletes an attribute named SWAP_DISABLED_CHAINS on any object. String constants are not inspected: a
    string only becomes a lookup through one of these names;
  - anything could change a value in place: any subscript store or delete, any augmented assignment, or a mutating
    method or function (append, extend, insert, remove, pop, clear, add, discard, update, sort, reverse, setdefault,
    popitem, the *_update set methods, operator's setitem/delitem/i* functions, bisect.insort*, heapq.heap*) on any
    receiver - called on the spot, read into a name that is used anywhere (`add = A.append; add(x)`), or read
    anywhere other than the value of a plain assignment (passed as an argument, put in a display) - so an alias
    (`A = SWAP_DISABLED_CHAINS; A.append(...)`) or an unbound method (`list.append(SWAP_DISABLED_CHAINS, ...)`) is
    caught as well as a direct call; a method call on the switch other than the read-only ones, or an attribute store
    or delete on it;
  - Chain is bound at module scope more than once, or by anything other than one top-level import, plain
    `Chain = ...` / `Chain: T = ...` assignment or undecorated def (a local `class Chain` whose ETH is the real
    Chain.ZCASH would make `(Chain.ETH,)` disable Zcash), or has an attribute stored or deleted, or is named by a
    global/nonlocal/walrus (a bare `Chain: T` binds nothing and is not counted; a plain function has no members, so
    Chain.X raises; this rule is the oracle's own, not the task's list);
  - frozenset (when the definition calls it) is bound anywhere at module scope, by a global/nonlocal/walrus, or stored
    as an attribute (builtins.frozenset = ...);
  - the value is not a literal tuple/list/set display, frozenset() or frozenset(<such a display>) whose elements are
    all Chain.X attribute reads. The reason then says which part fell outside that grammar: a call other than
    frozenset(...), a dict display, or an element that is not a Chain.X read.
Otherwise true iff one element is Chain.ZCASH (attribute names compared after Python's NFKC normalisation, as the
parser does).

The route and mutation checks are a denylist that over-approximates (a name such as `update` or `vars` makes the
answer unknown wherever it appears); they are not a proof that nothing else can reach the module's globals. Both
readers share one assumption the file itself cannot show: code in other modules (what an import runs, how Chain is
defined, enum aliases of Chain.ZCASH) does not reach back into this module.

Bindings inside function, lambda, class and comprehension scopes are local to those scopes and do not count, except
through global/nonlocal/walrus, which always count. The route and mutation checks apply in every scope.
"""

import ast
import base64
import json
import sys
import warnings

NAME = "SWAP_DISABLED_CHAINS"
CHAIN = "Chain"
# Names that reach module globals, frames or code execution, whatever the receiver or the import they come from.
DYNAMIC_NAMES = {
    "setattr", "delattr", "getattr", "globals", "vars", "locals", "exec", "eval", "compile", "__import__",
    "breakpoint", "modules", "_getframe", "currentframe", "f_globals", "f_locals", "methodcaller", "attrgetter",
    "getattr_static", "getmembers", "getmodule", "import_module", "reload", "exec_module", "run_module", "run_path",
    "FunctionType", "CodeType", "get_type_hints", "get_annotations", "call_annotate_function", "dictConfig",
    "fileConfig", "__builtins__",
}
# Modules that hand out builtins, frames, namespaces or code execution by name or from data (including deserialisers
# that call any callable and raw memory writes): using any name imported from them is unknown.
DYNAMIC_MODULES = {
    "builtins", "__builtin__", "gc", "inspect", "importlib", "ctypes", "_ctypes", "pickle", "_pickle", "cPickle",
    "marshal", "shelve", "copyreg", "dill", "cloudpickle", "jsonpickle", "yaml", "code", "codeop", "runpy", "timeit",
    "cProfile", "profile", "pdb", "bdb", "trace", "doctest", "pydoc", "pkgutil", "unittest", "mock",
}
# Methods and functions that change a list, set or dict in place.
MUTATORS = {
    "append", "extend", "insert", "remove", "pop", "clear", "add", "discard", "update", "sort", "reverse",
    "setdefault", "popitem", "difference_update", "intersection_update", "symmetric_difference_update",
    "setitem", "delitem", "iadd", "iand", "iconcat", "ior", "isub", "ixor", "imul",
    "insort", "insort_left", "insort_right", "heappush", "heappushpop", "heapreplace", "heapify",
}
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


def is_dunder(name):
    return len(name) > 4 and name.startswith("__") and name.endswith("__")


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
    if isinstance(elt, ast.Attribute) and isinstance(elt.value, ast.Name) and elt.value.id == CHAIN and isinstance(elt.ctx, ast.Load):
        return elt.attr
    return None


def literal_members(value):
    """(members, None) for a literal tuple/list/set display, frozenset() or frozenset(<display>) of Chain.X reads;
    otherwise (None, why), where `why` names the part outside that grammar."""
    if isinstance(value, ast.Call):
        if not (isinstance(value.func, ast.Name) and value.func.id == "frozenset"):
            called = value.func.id if isinstance(value.func, ast.Name) else "an expression"
            return None, "a call to %s() (only frozenset(...) is in the grammar)" % called
        if value.keywords or len(value.args) > 1 or (value.args and isinstance(value.args[0], ast.Starred)):
            return None, "frozenset(...) with keyword, starred or several arguments"
        if not value.args:
            return [], None
        value = value.args[0]
    if isinstance(value, ast.Dict):
        return None, "a dict display"
    if not isinstance(value, (ast.Tuple, ast.List, ast.Set)):
        return None, "not a tuple/list/set display (%s)" % type(value).__name__
    members = [chain_member(e) for e in value.elts]
    for i, m in enumerate(members):
        if m is None:
            return None, "element %d (%s) is not a Chain.X attribute read" % (i + 1, type(value.elts[i]).__name__)
    return members, None


def is_definition(stmt):
    """A top-level `NAME = v` (one plain target) or `NAME: T = v` (simple target, with a value)."""
    return is_plain_binding(stmt, NAME)


def is_plain_binding(stmt, name):
    if isinstance(stmt, ast.Assign):
        return len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name) and stmt.targets[0].id == name
    if isinstance(stmt, ast.AnnAssign):
        return isinstance(stmt.target, ast.Name) and stmt.target.id == name and stmt.simple == 1 and stmt.value is not None
    return False


def imports_name(stmt, name):
    """How many names `name` a top-level import statement binds."""
    if not isinstance(stmt, (ast.Import, ast.ImportFrom)):
        return 0
    return sum(1 for a in stmt.names if (a.asname or a.name.split(".")[0]) == name)


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
    chain_bindings = []  # (node, how) for Chain at module scope
    frozenset_bound = None
    how_by_target = target_kinds(tree)

    def bind(node, scope, name, how):
        nonlocal frozenset_bound
        if scope != "module":
            return
        if name == NAME:
            module_bindings.append((node, how))
        elif name == CHAIN:
            # A bare `Chain: T` binds nothing at run time; this rule is the oracle's own, so it follows the semantics.
            if not how.startswith("a bare annotation"):
                chain_bindings.append((node, how))
        elif name == "frozenset" and frozenset_bound is None:
            frozenset_bound = node

    def route(node, what):
        return unknown("%s: %s, a route to module globals or to running code" % (where(node), what))

    dynamic_imports = {}  # bound name -> (import statement, what it imports), for imports of routes
    loaded = set()  # every name read anywhere, in any scope
    mutator_aliases = {}  # name -> node, for names bound to a mutating method that is not called on the spot
    parents = {id(child): parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}

    def mutator_reference(node):
        """None when a reference to a mutating method is deferred, else the unknown result. Called on the spot
        (`A.append(x)`) it changes something; stored by a plain assignment (`X = A.append`) it does so only if that
        name is used later (checked after the walk); anywhere else (an argument, a display, ...) it may be called by
        code this reader does not follow."""
        parent = parents.get(id(node))
        if isinstance(parent, ast.Call) and parent.func is node:
            return unknown("%s: calls .%s(), which can change a collection in place" % (where(node), node.attr))
        child, up = node, parent
        while up is not None and not isinstance(up, ast.stmt):
            child, up = up, parents.get(id(up))
        if isinstance(up, (ast.Assign, ast.AnnAssign)) and child is up.value and isinstance(node.ctx, ast.Load):
            targets = up.targets if isinstance(up, ast.Assign) else [up.target]
            for t in targets:
                for n in ast.walk(t):
                    if isinstance(n, ast.Name):
                        mutator_aliases.setdefault(n.id, node)
            return None
        return unknown("%s: uses .%s, which can change a collection in place, other than in a plain assignment" % (where(node), node.attr))

    for node, scope in walk(tree):
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                bind(node, scope, node.id, how_by_target.get(id(node), "an assignment"))
            else:
                loaded.add(node.id)
            if node.id in DYNAMIC_NAMES:
                return route(node, "names %s" % node.id)
            if node.id in MUTATORS and isinstance(node.ctx, ast.Load):
                return unknown("%s: names %s, which can change a collection in place" % (where(node), node.id))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bind(node, scope, node.name, "a def or class statement")
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            # Handled per statement, not per alias: alias nodes carry no line number before Python 3.10.
            source = (node.module or "").split(".") if isinstance(node, ast.ImportFrom) else []
            for a in node.names:
                if a.name == "*":
                    return unknown("%s: a star import (it may bind any name, %s included)" % (where(node), NAME))
                parts = a.name.split(".") + ([a.asname] if a.asname else [])
                bound = a.asname if a.asname else parts[0]
                if any(p in DYNAMIC_MODULES for p in source + parts) or any(p in DYNAMIC_NAMES or p in MUTATORS or is_dunder(p) for p in parts):
                    # Unknown once the bound name is used anywhere (checked after the walk): `s(...)` after
                    # `from builtins import setattr as s` is setattr under another name.
                    dynamic_imports.setdefault(bound, (node, "%s%s%s" % ("from %s import " % node.module if source else "import ", a.name, " as %s" % a.asname if a.asname else "")))
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
            if node.name in (NAME, CHAIN):
                return unknown("%s: a type parameter named %s" % (where(node), node.name))
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            for n in (NAME, CHAIN):
                if n in node.names:
                    return unknown("%s: a global/nonlocal declaration of %s" % (where(node), n))
            if "frozenset" in node.names and frozenset_bound is None:
                frozenset_bound = node
        elif isinstance(node, ast.NamedExpr):
            if isinstance(node.target, ast.Name):
                if node.target.id in (NAME, CHAIN):
                    return unknown("%s: a walrus assignment to %s" % (where(node), node.target.id))
                if node.target.id == "frozenset" and frozenset_bound is None:
                    frozenset_bound = node
        elif isinstance(node, ast.AugAssign):
            return unknown("%s: an augmented assignment (it can change a collection in place)" % where(node))
        elif isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == NAME and f.attr not in READ_ONLY_METHODS:
                return unknown("%s: calls %s.%s(), which may change it in place" % (where(node), NAME, f.attr))
        elif isinstance(node, ast.Attribute):
            if node.attr in DYNAMIC_NAMES or is_dunder(node.attr):
                return route(node, "uses .%s" % node.attr)
            if node.attr in MUTATORS:
                found = mutator_reference(node)
                if found:
                    return found
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                if node.attr == NAME:
                    return unknown("%s: stores or deletes an attribute named %s" % (where(node), NAME))
                if node.attr == "frozenset" and frozenset_bound is None:
                    frozenset_bound = node
                if isinstance(node.value, ast.Name) and node.value.id in (NAME, CHAIN):
                    return unknown("%s: stores or deletes an attribute of %s" % (where(node), node.value.id))
        elif isinstance(node, ast.Subscript):
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                return unknown("%s: stores or deletes an item (it can change a collection or a namespace in place)" % where(node))

    for name, (node, what) in dynamic_imports.items():
        if name in loaded:
            return route(node, "%s, and %s is used" % (what, name))
    for name, node in mutator_aliases.items():
        if name in loaded:
            return unknown("%s: binds %s to .%s, which can change a collection in place, and %s is used" % (where(node), name, node.attr, name))
    if not module_bindings:
        return unknown("%s is not bound at module level" % NAME)
    if len(definitions) != 1 or len(module_bindings) != 1:
        lines = ", ".join("%s: %s" % (where(n), how) for n, how in module_bindings)
        return unknown("%s is bound %d time(s) at module level (%s), not by exactly one plain top-level definition" % (NAME, len(module_bindings), lines))
    if chain_bindings:
        # A top-level def without decorators is a plain function: Chain.X then raises, it cannot be another member.
        def plain_def(s):
            return isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and s.name == CHAIN and not s.decorator_list

        clean = sum(imports_name(s, CHAIN) + (1 if is_plain_binding(s, CHAIN) or plain_def(s) else 0) for s in tree.body)
        if len(chain_bindings) != 1 or clean != 1:
            lines = ", ".join("%s: %s" % (where(n), how) for n, how in chain_bindings)
            return unknown("%s is bound %d time(s) at module level (%s), not by exactly one top-level import or plain assignment, so Chain.X may not be the enum member" % (CHAIN, len(chain_bindings), lines))
    (definition,) = definitions
    value = definition.value
    if isinstance(value, ast.Call) and frozenset_bound is not None:
        return unknown("%s: frozenset is rebound" % where(frozenset_bound))
    members, why = literal_members(value)
    if members is None:
        return unknown("line %d: the value of %s is not a literal tuple/list/set/frozenset(...) of Chain.X members: %s" % (definition.lineno, NAME, why))
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

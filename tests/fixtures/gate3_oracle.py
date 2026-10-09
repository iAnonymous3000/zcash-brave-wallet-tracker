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
    dunder attribute (__dict__, __globals__, __setattr__, __class__, __iadd__, __init__, ...) or uses __builtins__.
    String constants are not inspected: a string only becomes a lookup through one of these names;
  - the module stores or deletes any attribute, on any receiver and in any scope. Through an alias such a store can
    give Chain a member-like attribute (`f = Chain; f.ETH = Chain.ZCASH`, `X = [Chain]; X[0].ETH = ...`, or a new
    `f.ETH2` on the real enum), patch the module Chain or frozenset is imported from (`m.Chain = FakeChain` before
    `from m import Chain`, `builtins.frozenset = tuple`) or rebind the switch on this module (`me.SWAP_DISABLED_CHAINS
    = ...`);
  - anything could change a value in place: any subscript store or delete, any augmented assignment, or a mutating
    method or function (append, extend, insert, remove, pop, clear, add, discard, update, sort, reverse, setdefault,
    popitem, the *_update set methods, operator's setitem/delitem/i* functions, bisect.insort*, heapq.heap*) on any
    receiver - called on the spot, read into a name that is used anywhere (`add = A.append; add(x)`), or read
    anywhere other than the value of a plain assignment (passed as an argument, put in a display) - so an alias
    (`A = SWAP_DISABLED_CHAINS; A.append(...)`) or an unbound method (`list.append(SWAP_DISABLED_CHAINS, ...)`) is
    caught as well as a direct call; a method call on the switch other than the read-only ones;
  - Chain, if bound at module scope, is not bound by exactly one of these top-level statements (this rule is the
    oracle's own, not the task's list; a bare `Chain: T` binds nothing and is not counted):
        an import (`from app.api.common.models import Chain`, `... import X as Chain`, `import m as Chain`);
        `Chain = v` or `Chain: T = v` where v is a constant, or a name or attribute path (`RealChain`,
            `models.Chain`) whose root is bound exactly once at module level, by a top-level import or by another
            such assignment (followed until it reaches an import, a constant, or a name this module never binds,
            which is a builtin or raises NameError);
        an undecorated def that is used nowhere except as `Chain.X` or copied by top-level plain aliases
            (`alias = Chain`) that are themselves used only that way (a plain function has no members, so Chain.X
            raises; passed on, `update_wrapper(Chain, C)` or `[Chain]`, it could be given attributes);
    or is named by a global/nonlocal/walrus. So a local class, a call (SimpleNamespace(ETH=...), type(...)), a lambda,
    or a name bound by one of those (`class _C: ETH = RealChain.ZCASH` then `Chain = _C`) is unknown: it could make
    `(Chain.ETH,)` disable Zcash;
  - the module imports itself as gate3 imports it, app.api.swap.constants (`import app.api.swap.constants as Chain`,
    `from app.api.swap import constants`, `from . import constants`, `from .constants import X`), and uses a name
    that import binds: run under that name, the import hands back this half-built module, so `Chain.ETH` can read this
    file's own `ETH = RealChain.ZCASH` (this rule is the oracle's own; an unused self-import changes nothing);
  - frozenset (when the definition calls it) is bound anywhere at module scope or by a global/nonlocal/walrus;
  - the value is not a literal tuple/list/set display, frozenset() or frozenset(<such a display>) whose elements are
    all Chain.X attribute reads. The reason then says which part fell outside that grammar: a call other than
    frozenset(...), a dict display, or an element that is not a Chain.X read.
Otherwise true iff one element is Chain.ZCASH (attribute names compared after Python's NFKC normalisation, as the
parser does).

The route and mutation checks are a denylist that over-approximates (a name such as `update` or `vars` makes the
answer unknown wherever it appears); they are not a proof that nothing else can reach the module's globals. Both
readers share assumptions the file itself cannot show: an imported Chain is gate3's enum (a plain Enum at 173a2408,
`class Chain(Enum)` in app/api/common/models.py, so a member equals only itself and Chain.X is the member X or
raises), and code in other modules (what an import runs, enum aliases of Chain.ZCASH) does not reach back into this
module. So `from app.fakes import FakeChain as Chain` and `import app.fakes as Chain` (another module's attributes
read as Chain.X) are taken on trust by both readers; under a str or int mixin a
member alias (`Chain = RealChain.ZCASH`, then `Chain.value`) or a numeric constant (`Chain = 1`, then `Chain.real`)
could also equal a member, which this oracle does not model.

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
SELF_MODULE = ("app", "api", "swap", "constants")  # the module this file is, in gate3 (app/api/swap/constants.py)
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


def imports_self(node):
    """Whether an import statement names this module itself, as gate3 imports it (app.api.swap.constants), absolutely
    or relative to its package: `import app.api.swap.constants as Chain`, `from app.api.swap import constants`,
    `from . import constants`, `from .constants import X`."""
    if isinstance(node, ast.Import):
        return any(tuple(a.name.split(".")) == SELF_MODULE for a in node.names)
    package = SELF_MODULE[:-1]
    if node.level > len(package):
        return False  # beyond the top-level package: ImportError when run
    base = package[: len(package) - node.level + 1] if node.level else ()
    full = base + (tuple(node.module.split(".")) if node.module else ())
    return full == SELF_MODULE or any(full + (a.name,) == SELF_MODULE for a in node.names)


def plain_def(stmt, name):
    """A def of `name` without decorators: it binds a plain function."""
    return isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and stmt.name == name and not stmt.decorator_list


def alias_problem(tree, value, names_bound, escaped, seen):
    """None when `value`, the right-hand side of `Chain = value`, can only be a constant, an imported object or an
    attribute path into one, following plain `A = B` aliases (each bound exactly once at module level); otherwise what
    it is. A local class, a call (SimpleNamespace(ETH=...), type(...)) or a name bound by either could define ETH as
    the real Chain.ZCASH."""
    if isinstance(value, ast.Constant):
        return None
    node = value
    while isinstance(node, ast.Attribute):
        node = node.value
    if not isinstance(node, ast.Name):
        return "an expression of type %s" % type(node).__name__
    root = node.id
    if root in escaped:
        return "%s, which a global, nonlocal or walrus binds" % root
    count = names_bound.get(root, 0)
    if root in seen or count == 0:
        # A name this module never binds (or a cycle of aliases, `A = B; B = A`, whose first statement reads a name not
        # yet bound) is a builtin or raises NameError. Neither can hold a member-like attribute: this module stores no
        # attribute and imports no route to builtins (both are unknown above).
        return None
    if count != 1:
        return "%s, which is bound %d time(s) at module level" % (root, count)
    binders = [s for s in tree.body if imports_name(s, root) or is_plain_binding(s, root)]
    if len(binders) != 1:
        return "%s, which is bound by something other than a top-level import or plain assignment" % root
    (stmt,) = binders
    if imports_name(stmt, root):
        return None
    return alias_problem(tree, stmt.value, names_bound, escaped, seen | {root})


def chain_binding_problem(tree, chain_bindings, names_bound, escaped, parents):
    """None when Chain, bound at module scope, still reads as the imported enum (under the shared assumption about how
    that enum is defined): one top-level import; one plain `Chain = value` / `Chain: T = value` whose value is a
    constant or an alias of an imported object (see alias_problem); or one undecorated def that is used only as
    `Chain.X` (a plain function has no members, so Chain.X raises; passed on or aliased, it could be given attributes,
    and every attribute store is unknown anyway). Otherwise why not."""
    binders = [s for s in tree.body if imports_name(s, CHAIN) or is_plain_binding(s, CHAIN) or plain_def(s, CHAIN)]
    if len(chain_bindings) != 1 or len(binders) != 1 or imports_name(binders[0], CHAIN) > 1:
        lines = ", ".join("%s: %s" % (where(n), how) for n, how in chain_bindings)
        return "%s is bound %d time(s) at module level (%s), not by exactly one top-level import, plain assignment or undecorated def, so Chain.X may not be the enum member" % (CHAIN, len(chain_bindings), lines)
    (stmt,) = binders
    if imports_name(stmt, CHAIN):
        return None
    if plain_def(stmt, CHAIN):
        # The function and its top-level plain aliases (`alias = Chain`, `a2 = alias`) may only be read as `X.attr` or
        # copied by such an alias; anything else (passed to update_wrapper, put in a list, aliased inside a function)
        # could give it attributes.
        aliases = {CHAIN}
        copies = set()  # id() of the Name loads that are the whole value of a top-level `alias = <name in aliases>`
        grew = True
        while grew:
            grew = False
            for s in tree.body:
                if isinstance(s, (ast.Assign, ast.AnnAssign)) and isinstance(s.value, ast.Name) and s.value.id in aliases:
                    target = s.targets[0] if isinstance(s, ast.Assign) else s.target
                    if is_plain_binding(s, getattr(target, "id", None)):
                        copies.add(id(s.value))
                        if target.id not in aliases:
                            aliases.add(target.id)
                            grew = True
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id in aliases and isinstance(node.ctx, ast.Load) and id(node) not in copies:
                parent = parents.get(id(node))
                if not (isinstance(parent, ast.Attribute) and parent.value is node):
                    return "%s: Chain is a function defined on line %d, and %s is used other than as %s.X or copied to a top-level alias (passed on, it could be given attributes such as ETH)" % (where(node), stmt.lineno, node.id, node.id)
        return None
    why = alias_problem(tree, stmt.value, names_bound, escaped, frozenset([CHAIN]))
    if why:
        return "line %d: Chain is bound to %s, not a constant or an alias of an imported object, so Chain.X may not be the enum member (a local class or namespace could define ETH as the real Chain.ZCASH)" % (stmt.lineno, why)
    return None


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
    names_bound = {}  # name -> how many times it is bound at module scope (any form), for the Chain alias rule
    escaped = set()  # names a global/nonlocal/walrus binds from some scope
    frozenset_bound = None
    how_by_target = target_kinds(tree)

    def bind(node, scope, name, how):
        nonlocal frozenset_bound
        if scope != "module":
            return
        if not how.startswith("a bare annotation"):
            names_bound[name] = names_bound.get(name, 0) + 1
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
    self_imports = {}  # bound name -> import statement, for imports of this module itself
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
            self_import = imports_self(node)
            # Handled per statement, not per alias: alias nodes carry no line number before Python 3.10.
            source = (node.module or "").split(".") if isinstance(node, ast.ImportFrom) else []
            for a in node.names:
                if a.name == "*":
                    return unknown("%s: a star import (it may bind any name, %s included)" % (where(node), NAME))
                parts = a.name.split(".") + ([a.asname] if a.asname else [])
                bound = a.asname if a.asname else parts[0]
                if self_import:
                    # Unknown once the bound name is used anywhere (checked after the walk). Run as
                    # app.api.swap.constants, the import hands back this half-built module or a name from it:
                    # `import app.api.swap.constants as Chain` makes Chain.ETH this file's own global ETH, which
                    # `ETH = RealChain.ZCASH` makes the real Chain.ZCASH.
                    self_imports.setdefault(bound, node)
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
            escaped.update(node.names)
            if "frozenset" in node.names and frozenset_bound is None:
                frozenset_bound = node
        elif isinstance(node, ast.NamedExpr):
            if isinstance(node.target, ast.Name):
                escaped.add(node.target.id)
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
                # Whatever the receiver: through an alias (`f = Chain; f.ETH = ...`, `X[0].ETH = ...`) it can give Chain
                # a member-like attribute, patch the module Chain or frozenset is imported from (`m.Chain = Fake`,
                # `builtins.frozenset = tuple`) or rebind the switch on this module (`me.SWAP_DISABLED_CHAINS = ...`).
                return unknown("%s: stores or deletes the attribute .%s (through an alias it can reach Chain, the module Chain or frozenset comes from, or this module)" % (where(node), node.attr))
        elif isinstance(node, ast.Subscript):
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                return unknown("%s: stores or deletes an item (it can change a collection or a namespace in place)" % where(node))

    for name, (node, what) in dynamic_imports.items():
        if name in loaded:
            return route(node, "%s, and %s is used" % (what, name))
    for name, node in self_imports.items():
        if name in loaded:
            return unknown("%s: imports this module itself (app.api.swap.constants) as %s, and %s is used, so it can read this module's own globals (Chain.ETH as this file's ETH)" % (where(node), name, name))
    for name, node in mutator_aliases.items():
        if name in loaded:
            return unknown("%s: binds %s to .%s, which can change a collection in place, and %s is used" % (where(node), name, node.attr, name))
    if not module_bindings:
        return unknown("%s is not bound at module level" % NAME)
    if len(definitions) != 1 or len(module_bindings) != 1:
        lines = ", ".join("%s: %s" % (where(n), how) for n, how in module_bindings)
        return unknown("%s is bound %d time(s) at module level (%s), %d of them a plain top-level definition, not by exactly one plain top-level definition" % (NAME, len(module_bindings), lines, len(definitions)))
    if chain_bindings:
        problem = chain_binding_problem(tree, chain_bindings, names_bound, escaped, parents)
        if problem:
            return unknown(problem)
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

"""What is in a Python file, from the standard library's own parser.

Reads absolute paths on stdin, one per line, and writes one JSON object per line to
stdout in the same order. Called by `python.ts`; not useful on its own.

One process for a whole batch of files rather than one per file: interpreter startup is
most of the cost and there is nothing to keep between calls, so this is a filter, never
a daemon. A daemon here would be a lifecycle bug waiting for a second ticket.

Nothing raises. A file that will not parse comes back with `unparsed` set and no symbols,
because a broken file is a fact about the tree and not a reason to fail the index.
"""

import ast
import json
import sys

# A call reported with every argument it was given is the thing that makes `where`
# worth more than grep: "solve(3 args)" answers the question grep sends you back to
# the file to answer.
CALL = "call"
DEFINITION = "definition"
IMPORT = "import"
ATTRIBUTE = "attribute"
ASSIGNMENT = "assignment"
READ = "read"


def facts(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            source = handle.read()
    except OSError as error:
        return {"path": path, "unparsed": str(error), "symbols": [], "references": []}

    lines = source.splitlines()
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as error:
        # Still a Python file, still worth its line count in a map. Only the inside
        # of it is unknown.
        return {
            "path": path,
            "unparsed": f"line {error.lineno}: {error.msg}",
            "symbols": [],
            "references": [],
        }

    collector = Collector(lines)
    collector.visit(tree)
    return {
        "path": path,
        "symbols": collector.symbols,
        "references": collector.references,
    }


class Collector(ast.NodeVisitor):
    """Symbols and references in one pass.

    Methods are qualified with their class (`Grid.spacing_m`) because an unqualified
    name is ambiguous in exactly the files where it matters most, and a reader
    scanning an outline wants to know what owns what.
    """

    def __init__(self, lines):
        self.lines = lines
        self.symbols = []
        self.references = []
        # (name, is_class) for each enclosing definition. The flag is what tells a
        # method from a function nested inside one — both are "not at module level",
        # and calling a closure a method sends a reader looking for a class.
        self.owner = []
        # Nodes that are the target of a call, by identity, so the thing being
        # called is reported once rather than as a call and again as what it was
        # spelled with. Populated by visit_Call before the walk descends into it.
        self.called_here = set()

    @property
    def path_here(self):
        return [name for name, _ in self.owner]

    @property
    def in_class(self):
        return bool(self.owner) and self.owner[-1][1]

    def text_at(self, lineno):
        """The source line, trimmed. One line is the interpretation; the file is not."""
        if 1 <= lineno <= len(self.lines):
            return self.lines[lineno - 1].strip()
        return ""

    def add_reference(self, kind, name, lineno, args=None):
        reference = {"kind": kind, "name": name, "line": lineno, "text": self.text_at(lineno)}
        if args is not None:
            reference["args"] = args
        self.references.append(reference)

    # -- definitions ------------------------------------------------------------

    def _function(self, node):
        signature = f"({ast.unparse(node.args)})"
        if node.returns is not None:
            signature += f" -> {ast.unparse(node.returns)}"

        self.symbols.append(
            {
                "kind": "method" if self.in_class else "function",
                "name": ".".join(self.path_here + [node.name]),
                "detail": signature,
                "line": node.lineno,
                "endLine": node.end_lineno or node.lineno,
            }
        )
        self.add_reference(DEFINITION, node.name, node.lineno)

        self.owner.append((node.name, False))
        self.generic_visit(node)
        self.owner.pop()

    def visit_FunctionDef(self, node):
        self._function(node)

    def visit_AsyncFunctionDef(self, node):
        self._function(node)

    def visit_ClassDef(self, node):
        self.symbols.append(
            {
                "kind": "class",
                "name": ".".join(self.path_here + [node.name]),
                "detail": f"({', '.join(ast.unparse(b) for b in node.bases)})" if node.bases else "",
                "line": node.lineno,
                "endLine": node.end_lineno or node.lineno,
            }
        )
        self.add_reference(DEFINITION, node.name, node.lineno)

        self.owner.append((node.name, True))
        self.generic_visit(node)
        self.owner.pop()

    def visit_Assign(self, node):
        # Module-level assignments are the constants this repository turns on — a
        # wrong `R_SPECIFIC_AIR` is the silent unit error the Python skill is about —
        # so they belong in the outline beside the functions.
        for target in node.targets:
            if isinstance(target, ast.Name):
                if not self.owner:
                    self.symbols.append(
                        {
                            "kind": "const",
                            "name": target.id,
                            "detail": one_line(ast.unparse(node.value)),
                            "line": node.lineno,
                            "endLine": node.end_lineno or node.lineno,
                        }
                    )
                self.add_reference(ASSIGNMENT, target.id, target.lineno)
        self.generic_visit(node)

    # -- references -------------------------------------------------------------

    def visit_Import(self, node):
        for alias in node.names:
            self.add_reference(IMPORT, alias.asname or alias.name, node.lineno)
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        for alias in node.names:
            self.add_reference(IMPORT, alias.asname or alias.name, node.lineno)
        self.generic_visit(node)

    def visit_Call(self, node):
        name = called(node.func)
        if name is not None:
            # Starred arguments make the count a lower bound, which is still the
            # useful half of the answer; the source line is right there beside it.
            total = len(node.args) + len(node.keywords)
            self.add_reference(CALL, name, node.lineno, args=total)
            # The thing being called is reported once, as a call. Without this,
            # `m.convert(x)` came back as both a call and an attribute, and every
            # method call in the codebase was counted twice.
            self.called_here.add(id(node.func))
        self.generic_visit(node)

    def visit_Attribute(self, node):
        if id(node) not in self.called_here:
            self.add_reference(ATTRIBUTE, node.attr, node.lineno)
        self.generic_visit(node)

    def visit_Name(self, node):
        # A name that is merely read: `TOTAL` in `x + TOTAL`. Without this a
        # constant used inside its own module looked unused — `where` reported the
        # assignment and nothing else, which is the dangerous direction to be wrong
        # in, because an agent trusts it and deletes something.
        if isinstance(node.ctx, ast.Load) and id(node) not in self.called_here:
            self.add_reference(READ, node.id, node.lineno)
        self.generic_visit(node)


def called(func):
    """The name a call names. `solve(...)`, `np.solve(...)` and `self.solve(...)` all
    report `solve` — the attribute owner is on the source line if it matters, and
    reporting them separately would hide the calls you were looking for."""
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def one_line(text, limit=60):
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def main():
    for line in sys.stdin:
        path = line.strip()
        if path:
            sys.stdout.write(json.dumps(facts(path)) + "\n")


if __name__ == "__main__":
    main()

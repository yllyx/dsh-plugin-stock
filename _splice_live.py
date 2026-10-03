import io
p = "plugin/lib/client.js"
lines = io.open(p, encoding="utf-8").read().split("\n")
start = next(i for i, l in enumerate(lines) if "function KplLiveSub" in l)
end = next(i for i, l in enumerate(lines) if "function KplStockSub" in l) - 1
while lines[end].strip() == "" or lines[end].strip().startswith("/*") or lines[end].strip().startswith("//"):
    end -= 1
assert lines[end].strip() == "}", "bad end: %r" % lines[end]
new = io.open("_live_rewrite.js", encoding="utf-8").read().rstrip("\n").split("\n")
out = lines[:start] + new + ["", ""] + lines[end + 1:]
io.open(p, "w", encoding="utf-8", newline="\n").write("".join(x + "\n" for x in out))
print("rewrote %d..%d -> %d lines" % (start + 1, end + 1, len(new)))

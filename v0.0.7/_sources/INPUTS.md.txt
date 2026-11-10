# ConditionSpec and Studio

RFD4 owns ConditionSpec: its JSON/YAML schema, contig parsing, compilation into
annotated structures, and inference preparation. Studio does not carry a second
parser, schema, or condition-spec command-line tool.

Studio owns visualization and interactive editing of annotated structures,
including selections, condition widgets, undo, and annotated-CIF export. The
shared document layer preserves annotation fields and independent coordinate
groups when combining structures.

To inspect a ConditionSpec result today, compile it with the corresponding RFD4
runtime and open the resulting annotated CIF in Studio. Studio currently does
not import JSON/YAML specs directly or preserve their source expressions and
contigs when editing a structure. Annotated-CIF edits are not a lossless JSON
round trip.

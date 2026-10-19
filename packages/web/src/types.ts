export type ConditionDefinition = {
  label: string;
  kind: "mask" | "enum" | "integer" | "scalar" | "vector3" | "pair" | "operation" | "text";
  level: string;
  default: number | boolean | string | null;
  values?: Record<string, number>;
  group_editor?: boolean;
  invert_mask?: boolean;
  editor_group?: string;
  option_label?: string;
  minimum?: number;
  maximum?: number;
  step?: number;
  decimals?: number;
};

export type StudioSchema = {
  document_operations?: string[];
  editor_tabs: Array<{ id: string; label: string }>;
  conditions: Record<string, ConditionDefinition>;
  bond_types: string[];
  loading: {
    fields: Record<string, { label: string; kind: "boolean" | "integer" | "choice" | "text"; choices?: string[] }>;
    presets: Record<string, Record<string, unknown>>;
  };
};

export type Restraint = {
  atom1: number; atom2: number; atom1_label: string; atom2_label: string;
  distance: number; current_distance: number | null;
};
export type ConditionEditorState = {
  groups: Record<string, Array<{ id: number; count: number; can_delete: boolean }>>;
  centroids: Record<string, Array<{ chain: string; current: number[] | null; target: number[] | null }>>;
  restraints: Restraint[];
};

export type AnnotationValue = {
  label: string;
  value?: number | number[] | string | boolean | null;
  count: number;
  atom_indices?: number[];
  color?: { name: string; value: number };
};

export type AnnotationSummary = {
  name: string;
  label: string;
  count: number;
  unit: string;
  values: AnnotationValue[];
  truncated?: boolean;
};

export type SequenceResidue = {
  kind: "residue";
  atom_indices: number[];
  residue_id: number;
  residue_name: string;
  code: string;
  conditions: string[];
};

export type SequenceSegment = {
  kind: "segment";
  atom_indices: number[];
  minimum: number;
  maximum: number;
  realized: boolean;
  realized_length: number | null;
};

export type SequenceChain = {
  chain_id: string;
  items: Array<SequenceResidue | SequenceSegment>;
};

export type StructureSummary = {
  revision: number;
  condition_editors: ConditionEditorState;
  name: string;
  atom_count: number;
  chain_ids: string[];
  next_chain_id: string;
  sequence: SequenceChain[];
  condition_counts: Record<string, number>;
  annotations: AnnotationSummary[];
  stored_fields: AnnotationSummary[];
  scalar_fields: AnnotationSummary[];
  undo_depth: number;
  validation: Array<{ severity: string; check: string; message: string }>;
};

export type SessionResponse = {
  session_id: string;
  editor_path?: string;
  structure: StructureSummary;
  edit_result?: { message?: string; affected_count?: number; skipped_count?: number; group_id?: number; changed?: boolean };
};

export type SelectionScope = "atom" | "residue" | "chain";
export type SelectionSyntax = "patinae" | "expression" | "path";

export type AnalysisResult = {
  label?: string;
  name?: string;
  value?: number | string;
  unit?: string;
  atom_indices?: number[];
  [key: string]: unknown;
};

export type InteractionResult = {
  type: string;
  interaction_type: string;
  atom1: number;
  atom2: number;
  atom1_role: string;
  atom2_role: string;
  distance: number;
};

export type InteractionAnalysisResponse = {
  revision: number;
  cached: boolean;
  interaction_count: number;
  interactions: InteractionResult[];
};

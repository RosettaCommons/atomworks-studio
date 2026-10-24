// Mol* colour theme backed by the shared chain palette (src/chain-colors.ts) rather than Mol*'s own order-based one,
// so a chain is the same colour in the viewer as in the sequence bar.
//
// Carbons (and the cartoon, which is traced through carbon atoms) take their chain's colour. With `carbonOnly`, other
// elements keep standard element colours, so ligands and heteroatoms stay readable; otherwise every atom takes the
// chain colour.
import { Bond, StructureElement, StructureProperties } from "molstar/lib/mol-model/structure";
import type { Location } from "molstar/lib/mol-model/location";
import type { ColorTheme } from "molstar/lib/mol-theme/color";
import { ElementSymbolColors, elementSymbolColor } from "molstar/lib/mol-theme/color/element-symbol";
import type { ThemeDataContext } from "molstar/lib/mol-theme/theme";
import { Color } from "molstar/lib/mol-util/color";
import { ParamDefinition as PD } from "molstar/lib/mol-util/param-definition";
import { chainColor } from "../chain-colors";

const Params = { carbonOnly: PD.Boolean(true) };
type Params = typeof Params;

const UNKNOWN = Color(0xbbbbbb);

function StudioChainColorTheme(_ctx: ThemeDataContext, props: PD.Values<Params>): ColorTheme<Params> {
  const cache = new Map<string, Color>();
  const byChain = (location: StructureElement.Location): Color => {
    // label_asym_id is the chain id the document and the sequence bar use; auth ids can differ in RCSB files.
    const id = StructureProperties.chain.label_asym_id(location);
    let color = cache.get(id);
    if (color === undefined) cache.set(id, (color = Color(chainColor(id))));
    return color;
  };
  const atom = (location: StructureElement.Location): Color => {
    if (!props.carbonOnly) return byChain(location);
    const symbol = StructureProperties.atom.type_symbol(location);
    return symbol === "C" ? byChain(location) : elementSymbolColor(ElementSymbolColors, symbol);
  };
  const bondLocation = StructureElement.Location.create();
  const color = (location: Location): Color => {
    if (StructureElement.Location.is(location)) return atom(location);
    if (Bond.isLocation(location)) {
      bondLocation.structure = location.aStructure;
      bondLocation.unit = location.aUnit;
      bondLocation.element = location.aUnit.elements[location.aIndex];
      return atom(bondLocation);
    }
    return UNKNOWN;
  };
  return {
    factory: StudioChainColorTheme,
    granularity: "group",
    color,
    props,
    description: "Chain colours shared with the sequence bar.",
  };
}

export const StudioChainColorThemeProvider: ColorTheme.Provider<Params, "studio-chain"> = {
  name: "studio-chain",
  label: "Chain (Studio)",
  category: "Chain Property",
  factory: StudioChainColorTheme,
  getParams: () => Params,
  defaultValues: PD.getDefaultValues(Params),
  isApplicable: (ctx: ThemeDataContext) => !!ctx.structure,
};

// Verified against Airbnb's public filter controls, applied search parameters,
// and returned listing labels on 2026-11-15. These are not room-type IDs.
// Broad groups use l2_property_type_ids; cabins/villas use property_type_id;
// the current Hotel control uses a tag rather than an old numeric group ID.
export const BUILDING_TYPES = {
  house: { label: "House", parameter: "l2_property_type_ids[]", value: "1", description: "Airbnb's broad house group, including related house-style stays." },
  apartment: { label: "Apartment", parameter: "l2_property_type_ids[]", value: "3", description: "Airbnb's broad apartment group, which can include condos." },
  guesthouse: { label: "Guesthouse", parameter: "l2_property_type_ids[]", value: "2", description: "Airbnb's guesthouse group, including guest suites." },
  hotel: { label: "Hotel", parameter: "kg_and_tags[]", value: "Tag:9613", description: "Airbnb's hotel filter. Choose the room type separately if needed." },
  cabin: { label: "Cabin", parameter: "property_type_id[]", value: "4", description: "Cabins specifically, rather than the broad house group." },
  villa: { label: "Villa", parameter: "property_type_id[]", value: "11", description: "Villas specifically, rather than the broad house group." },
} as const;

export function validateBuildingType(value: unknown): asserts value is keyof typeof BUILDING_TYPES | undefined {
  if (value !== undefined && (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(BUILDING_TYPES, value))) {
    throw new Error(`buildingType must be one of: ${Object.keys(BUILDING_TYPES).join(", ")}`);
  }
}

export function applyBuildingType(url: URL, value: unknown) {
  validateBuildingType(value);
  if (value === undefined) return;
  const filter = BUILDING_TYPES[value];
  url.searchParams.append(filter.parameter, filter.value);
}

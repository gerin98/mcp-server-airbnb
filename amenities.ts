// Verified against Airbnb's search-page filter labels and searchParams on 2026-11-15.
// These are search filter IDs, which can differ from listing-detail amenity IDs.
export const AMENITIES: Record<string, { id: string; label: string; description: string }> = {
  wifi: { id: "4", label: "Wi-Fi", description: "Wireless internet access. Check listing details for speed and coverage." },
  kitchen: { id: "8", label: "Kitchen", description: "Access to a kitchen. Equipment and whether it is shared vary by listing." },
  washer: { id: "33", label: "Washer", description: "Access to a washing machine. Check its location, shared access, and any fees." },
  dryer: { id: "34", label: "Dryer", description: "Access to a clothes dryer. Check its location, shared access, and any fees." },
  air_conditioning: { id: "5", label: "Air conditioning", description: "Air conditioning is listed. Check which rooms it covers." },
  heating: { id: "30", label: "Heating", description: "Heating is listed. Check the type and rooms covered." },
  dedicated_workspace: { id: "47", label: "Dedicated workspace", description: "A space intended for working. Check the desk, seating, and privacy." },
  tv: { id: "58", label: "TV", description: "A television is available. Channels and streaming subscriptions vary." },
  hair_dryer: { id: "45", label: "Hair dryer", description: "A hair dryer is listed among the amenities." },
  iron: { id: "46", label: "Iron", description: "A clothes iron is listed among the amenities." },
  pool: { id: "7", label: "Pool", description: "Access to a pool, which may be shared. Check seasonal availability, heating, and access hours." },
  hot_tub: { id: "25", label: "Hot tub", description: "Access to a hot tub, which may be shared. Check availability and access rules." },
  free_parking: { id: "9", label: "Free parking", description: "Free parking is listed. Check location, space availability, and vehicle restrictions." },
  ev_charger: { id: "97", label: "EV charger", description: "EV charging is listed. Check connector compatibility, charging speed, access, and fees." },
  crib: { id: "286", label: "Crib", description: "A crib is listed. Check its type and whether it must be requested." },
  king_bed: { id: "1000", label: "King bed", description: "A king bed is listed. Check the sleeping arrangements and room assignment." },
  gym: { id: "15", label: "Gym", description: "Access to a gym, which may be shared. Check equipment, access hours, and fees." },
  bbq_grill: { id: "99", label: "BBQ grill", description: "Access to a barbecue grill. Check fuel, shared access, and usage rules." },
  breakfast: { id: "16", label: "Breakfast", description: "Breakfast is listed. Check what is provided and when it is available." },
  indoor_fireplace: { id: "27", label: "Indoor fireplace", description: "An indoor fireplace is listed. Check its type, fuel, and usage rules." },
  self_check_in: { id: "51", label: "Self check-in", description: "Check-in without an in-person handoff is listed. Follow the host's access instructions and check-in times." },
  smoking_allowed: { id: "11", label: "Smoking allowed", description: "Smoking is permitted in some capacity. Check house rules for designated areas and restrictions." },
  smoke_alarm: { id: "35", label: "Smoke alarm", description: "The host lists a smoke alarm; this filter is not an independent verification of its condition." },
  carbon_monoxide_alarm: { id: "36", label: "Carbon monoxide alarm", description: "The host lists a carbon monoxide alarm; this filter is not an independent verification of its condition." },
};

export const AMENITY_IDS: Record<string, string> = Object.fromEntries(
  Object.entries(AMENITIES).map(([name, { id }]) => [name, id])
);

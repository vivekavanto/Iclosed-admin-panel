"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { MapPin, Loader2 } from "lucide-react";

// Google Places address input, ported from the customer portal. Needs
// NEXT_PUBLIC_GOOGLE_PLACES_API_KEY; without it this is a plain text box.

interface SelectedAddress {
  street: string;
  city: string;
  postalCode: string;
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelect: (data: SelectedAddress) => void;
  onBlur?: () => void;
  hasError?: boolean;
  placeholder?: string;
  /** Replaces the default input classes. Must include `pl-9` for the pin icon. */
  inputClassName?: string;
  /** False allows all of Canada — for mailing addresses, not property addresses. */
  restrictToOntario?: boolean;
}

const ONTARIO_BOUNDS = {
  south: 41.68,
  west: -95.16,
  north: 56.86,
  east: -74.34,
};

/* ── Load Google Maps script once globally ── */
let googleScriptPromise: Promise<void> | null = null;

function loadGoogleMapsScript(): Promise<void> {
  if (googleScriptPromise) return googleScriptPromise;

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error("Missing NEXT_PUBLIC_GOOGLE_PLACES_API_KEY env variable");
    return Promise.reject(new Error("Missing Google Places API key"));
  }

  if (typeof window !== "undefined" && window.google?.maps?.places) {
    googleScriptPromise = Promise.resolve();
    return googleScriptPromise;
  }

  googleScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      googleScriptPromise = null;
      reject(new Error("Failed to load Google Maps script"));
    };
    document.head.appendChild(script);
  });

  return googleScriptPromise;
}

/* ── Extract address components from a Place result ── */
function extractAddress(place: {
  address_components?: google.maps.GeocoderAddressComponent[];
}): SelectedAddress {
  const components = place.address_components ?? [];
  let streetNumber = "";
  let route = "";
  let city = "";
  let postalCode = "";

  for (const c of components) {
    const type = c.types[0];
    switch (type) {
      case "street_number":
        streetNumber = c.long_name;
        break;
      case "route":
        route = c.long_name;
        break;
      case "locality":
        city = c.long_name;
        break;
      case "sublocality_level_1":
        if (!city) city = c.long_name;
        break;
      case "administrative_area_level_3":
        if (!city) city = c.long_name;
        break;
      case "postal_code":
        postalCode = c.long_name;
        break;
    }
  }

  return {
    street: [streetNumber, route].filter(Boolean).join(" "),
    city,
    postalCode,
  };
}

export default function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  onBlur,
  hasError,
  placeholder = "123 Main Street",
  inputClassName,
  restrictToOntario = false,
}: AddressAutocompleteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [scriptError, setScriptError] = useState(false);
  const [provinceError, setProvinceError] = useState<string | null>(null);

  // Stable refs for callbacks (avoids re-initializing autocomplete)
  const onChangeRef = useRef(onChange);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // Load the Google Maps script
  useEffect(() => {
    loadGoogleMapsScript()
      .then(() => setScriptLoaded(true))
      .catch(() => setScriptError(true));
  }, []);

  // Initialize the autocomplete once the script is loaded
  useEffect(() => {
    if (!scriptLoaded || !inputRef.current || autocompleteRef.current) return;

    const autocomplete = new google.maps.places.Autocomplete(inputRef.current, {
      componentRestrictions: { country: "ca" },
      types: ["address"],
      fields: ["address_components", "formatted_address", "geometry"],
      ...(restrictToOntario
        ? { bounds: ONTARIO_BOUNDS, strictBounds: true }
        : {}),
    });

    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (!place.address_components) return;

      if (restrictToOntario) {
        const province = place.address_components.find((c) =>
          c.types.includes("administrative_area_level_1"),
        );
        if (province?.short_name !== "ON") {
          setProvinceError("Please select an address in Ontario.");
          onChangeRef.current("");
          return;
        }
      }
      setProvinceError(null);

      const extracted = extractAddress(place);
      onChangeRef.current(extracted.street);
      onSelectRef.current(extracted);
    });

    autocompleteRef.current = autocomplete;
  }, [scriptLoaded, restrictToOntario]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (provinceError) setProvinceError(null);
      onChange(e.target.value);
    },
    [onChange, provinceError],
  );

  return (
    <div className="relative w-full">
      <div className="relative">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
          {!scriptLoaded && !scriptError ? (
            <Loader2 size={15} className="text-gray-400 animate-spin" />
          ) : (
            <MapPin size={15} className="text-gray-400" />
          )}
        </div>

        <input
          ref={inputRef}
          type="text"
          autoComplete="off"
          value={value}
          onChange={handleChange}
          onBlur={onBlur}
          placeholder={placeholder}
          className={
            inputClassName ??
            [
              "w-full pl-9 pr-4 py-3 rounded-lg border text-sm bg-white",
              hasError
                ? "border-[#C10007] focus:outline-none focus:ring-1 focus:ring-[#C10007]"
                : "border-gray-200 focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]",
            ].join(" ")
          }
        />
      </div>

      {scriptError && (
        <p className="text-xs text-amber-600 mt-1">
          Address suggestions unavailable — type the address manually.
        </p>
      )}
      {provinceError && (
        <p className="text-xs text-[#C10007] mt-1">{provinceError}</p>
      )}
    </div>
  );
}

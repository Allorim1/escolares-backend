const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

const PLACES_AUTOCOMPLETE_URL = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const GEOCODING_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';

export const googleMapsService = {
  async autocomplete(input: string, sessionToken?: string): Promise<any> {
    if (!GOOGLE_MAPS_API_KEY) {
      throw new Error('GOOGLE_MAPS_API_KEY no configurada');
    }

    const params = new URLSearchParams({
      input,
      key: GOOGLE_MAPS_API_KEY,
      components: 'country:ve',
      language: 'es',
    });

    if (sessionToken) {
      params.append('session_token', sessionToken);
    }

    const response = await fetch(`${PLACES_AUTOCOMPLETE_URL}?${params}`);
    const data = await response.json();
    
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Places API error: ${data.status}`);
    }

    return data.predictions;
  },

  async geocode(address: string): Promise<any> {
    if (!GOOGLE_MAPS_API_KEY) {
      throw new Error('GOOGLE_MAPS_API_KEY no configurada');
    }

    const params = new URLSearchParams({
      address,
      key: GOOGLE_MAPS_API_KEY,
      language: 'es',
    });

    const response = await fetch(`${GEOCODING_URL}?${params}`);
    const data = await response.json();

    if (data.status !== 'OK') {
      throw new Error(`Geocoding API error: ${data.status}`);
    }

    const result = data.results[0];
    return {
      placeId: result.place_id,
      formattedAddress: result.formatted_address,
      location: {
        lat: result.geometry.location.lat,
        lng: result.geometry.location.lng,
      },
    };
  },

  async geocodePlaceId(placeId: string): Promise<any> {
    if (!GOOGLE_MAPS_API_KEY) {
      throw new Error('GOOGLE_MAPS_API_KEY no configurada');
    }

    const params = new URLSearchParams({
      place_id: placeId,
      key: GOOGLE_MAPS_API_KEY,
      language: 'es',
    });

    const response = await fetch(`${GEOCODING_URL}?${params}`);
    const data = await response.json();

    if (data.status !== 'OK') {
      throw new Error(`Geocoding API error: ${data.status}`);
    }

    const result = data.results[0];
    return {
      placeId: result.place_id,
      formattedAddress: result.formatted_address,
      location: {
        lat: result.geometry.location.lat,
        lng: result.geometry.location.lng,
      },
    };
  },

  async getDirections(
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
    mode: 'driving' | 'walking' | 'bicycling' = 'driving'
  ): Promise<any> {
    if (!GOOGLE_MAPS_API_KEY) {
      throw new Error('GOOGLE_MAPS_API_KEY no configurada');
    }

    const params = new URLSearchParams({
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      key: GOOGLE_MAPS_API_KEY,
      mode,
      language: 'es',
    });

    const response = await fetch(`${DIRECTIONS_URL}?${params}`);
    const data = await response.json();

    if (data.status !== 'OK') {
      throw new Error(`Directions API error: ${data.status}`);
    }

    const route = data.routes[0];
    const leg = route.legs[0];

    return {
      distance: leg.distance,
      duration: leg.duration,
      steps: leg.steps.map((step: any) => ({
        instruction: step.html_instructions.replace(/<[^>]*>/g, ''),
        distance: step.distance,
        duration: step.duration,
        startLocation: step.start_location,
        endLocation: step.end_location,
      })),
      overviewPolyline: route.overview_polyline,
    };
  },
};
// Type stub for @googlemaps/markerclusterer to silence TS2307 in this project.
// This file does not change runtime behavior.
declare module "@googlemaps/markerclusterer" {
  export class MarkerClusterer {
    constructor(options?: any);
    addMarker(marker: any, noDraw?: boolean): void;
    addMarkers(markers: any[], noDraw?: boolean): void;
    removeMarker(marker: any, noDraw?: boolean): boolean;
    removeMarkers(markers: any[], noDraw?: boolean): boolean;
    clearMarkers(): void;
    render(): void;
    setMap(map: any): void;
    getMap(): any;
  }
}

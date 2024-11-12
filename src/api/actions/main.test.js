import { assertEquals, assertObjectMatch } from "jsr:@std/assert";
import { delay } from "jsr:@std/async";
import actionExecutor from "./main.js";

// Move the OpenAPI spec to a separate fixture file and import it
const specs = `openapi: 3.0.0\ninfo:\n  title: Bus Booking API\n  version: 1.0.0\n  description: API for searching and booking bus trips between cities\n\nservers:\n  - url: https://mobizap-api.jaze.ai\n    description: Production server\n\npaths:\n  features/startSession:\n    post:\n      operationId: startSession\n      summary: Initialize a new session\n      description: Creates a new session and retrieves necessary cookies for subsequent requests\n      responses:\n        '200':\n          description: Session created successfully\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  sessionId:\n                    type: string\n                    description: Unique session identifier to be used in subsequent requests\n                    example: \"550e8400-e29b-41d4-a716-446655440000\"\n  features/checkRoute:\n    post:\n      operationId: checkRoute\n      summary: Check available routes between origin and destination\n      description: Validates and retrieves route information between two cities\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              required:\n                - sessionId\n                - origin\n                - destination\n              properties:\n                sessionId:\n                  type: string\n                  description: Unique identifier for the user's session\n                  example: \"123\"\n                origin:\n                  type: string\n                  description: Name of the departure city\n                  example: \"são pedro\"\n                destination:\n                  type: string\n                  description: Name of the arrival city\n                  example: \"Piracicaba\"\n      responses:\n        '200':\n          description: Route found successfully\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  origin:\n                    type: object\n                    description: Details about the departure location\n                    properties:\n                      id: \n                        type: string\n                        description: Unique identifier for the origin city\n                      name:\n                        type: string\n                        description: Full name of the origin city\n                      uf:\n                        type: string\n                        description: State/province code where the origin city is located\n                  destination:\n                    type: object\n                    description: Details about the arrival location\n                    properties:\n                      id:\n                        type: string\n                        description: Unique identifier for the destination city\n                      name:\n                        type: string\n                        description: Full name of the destination city\n                      uf:\n                        type: string\n                        description: State/province code where the destination city is located\n        '404':\n          description: No route found between the specified cities\n\n  features/searchTrips:\n    post:\n      operationId: searchTrips\n      summary: Search for available trips\n      description: Searches for bus trips based on route and preferences\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              required:\n                - date\n                - sessionId\n              properties:\n                date:\n                  type: string\n                  format: date\n                  description: Travel date in DD-MM-YYYY format\n                  example: \"09-11-2024\"\n                sessionId:\n                  type: string\n                  description: Unique identifier for the user's session\n                preferences:\n                  type: object\n                  description: Optional filtering preferences for the search\n                  properties:\n                    period:\n                      type: string\n                      description: Preferred time of day for travel\n                      enum: [soonest, morning, afternoon, evening, night, any]\n                    class:\n                      type: string\n                      description: Preferred bus service class\n                      enum: [bed, executive, regular, any]\n                    connections:\n                      type: string\n                      description: Preferred number of connections\n                      enum: [direct, one, two, any]\n                    speed:\n                      type: string\n                      description: Preference for journey duration\n                      enum: [fastest, fast, any]\n                    price:\n                      type: string\n                      description: Price range preference\n                      enum: [lowest, promotions, low, medium, high, any]\n      responses:\n        '200':\n          description: Trips found successfully\n          content:\n            application/json:\n              schema:\n                type: array\n                items:\n                  type: object\n                  properties:\n                    companyName:\n                      type: string\n                      description: Name of the bus company\n                    classes:\n                      type: array\n                      description: Available service classes for this company\n                      items:\n                        type: object\n                        properties:\n                          className:\n                            type: string\n                            description: Type of service class (e.g., executive, regular)\n                          trips:\n                            type: array\n                            description: List of available trips for this class\n                            items:\n                              type: object\n                              properties:\n                                id:\n                                  type: number\n                                  description: Unique identifier for the trip\n                                price:\n                                  type: number\n                                  description: Trip fare in local currency\n                                arrival:\n                                  type: string\n                                  description: Arrival time in HH:mm format\n                                departure:\n                                  type: string\n                                  description: Departure time in HH:mm format\n                                connection:\n                                  type: boolean\n                                  description: Whether the trip has connections\n\n  features/selectTrip:\n    post:\n      operationId: selectTrip\n      summary: Select a specific trip\n      description: Reserves a specific trip for the booking process\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              required:\n                - sessionId\n                - tripId\n              properties:\n                sessionId:\n                  type: string\n                  description: Unique identifier for the user's session\n                tripId:\n                  type: number\n                  description: ID of the selected trip\n      responses:\n        '200':\n          description: Trip selected successfully\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  company:\n                    type: string\n                    description: Name of the bus company\n                  departure:\n                    type: string\n                    description: Departure time in HH:mm format\n                  arrival:\n                    type: string\n                    description: Arrival time in HH:mm format\n                  class:\n                    type: string\n                    description: Service class of the selected trip\n        '404':\n          description: Trip not found\n  features/getSeats:\n    post:\n      operationId: getSeats\n      summary: Get available seats for a selected trip\n      description: Retrieves and optionally filters available seats based on preferences\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              required:\n                - sessionId\n              properties:\n                sessionId:\n                  type: string\n                  description: Unique identifier for the user's session\n                preferences:\n                  type: object\n                  description: Optional seat filtering preferences\n                  properties:\n                    seatType:\n                      type: string\n                      description: Preferred position within the row\n                      enum: [window, aisle, middle]\n                    side:\n                      type: string\n                      description: Preferred side of the bus\n                      enum: [left, right]\n                    position:\n                      type: string\n                      description: Preferred position in the bus\n                      enum: [front, middle, back]\n                    isDouble:\n                      type: boolean\n                      description: Whether the seat should have an adjacent available seat\n                    numbers:\n                      type: array\n                      description: Specific seat numbers to filter by\n                      items:\n                        type: number\n                      example: [1, 2, 3]\n      responses:\n        '200':\n          description: Seats retrieved successfully\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  allSeats:\n                    type: array\n                    description: Complete seat map of the bus\n                    items:\n                      type: array\n                      description: Row of seats\n                      items:\n                        type: string\n                        description: Seat identifier ('X' for unavailable, 'C' for corridor, or seat number)\n                    example: [\n                      [\"01\", \"02\", \"C\", \"03\", \"04\"],\n                      [\"05\", \"X\", \"C\", \"07\", \"08\"]\n                    ]\n                  preferredSeats:\n                    type: array\n                    description: Filtered list of seats matching preferences\n                    items:\n                      type: string\n                      description: Seat number\n                    example: [\"01\", \"04\", \"08\"]\n        '404':\n          description: Session not found or invalid\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/Error'\n  features/selectSeats:\n    post:\n      operationId: selectSeats\n      summary: Select seats for a trip\n      description: Attempts to reserve specific seats for the selected trip\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              required:\n                - sessionId\n                - seats\n              properties:\n                sessionId:\n                  type: string\n                  description: Unique identifier for the user's session\n                seats:\n                  type: array\n                  description: List of seat numbers to reserve\n                  items:\n                    type: string\n                  example: [\"01\", \"02\"]\n      responses:\n        '200':\n          description: Seats selected successfully\n          content:\n            application/json:\n              schema:\n                type: array\n                description: Array of seat reservation confirmations\n                items:\n                  type: object\n                  description: Seat reservation details\n\ncomponents:\n  schemas:\n    Error:\n      type: object\n      properties:\n        message:\n          type: string\n          description: Human-readable error description\n        code:\n          type: string\n          description: Machine-readable error code\n    SeatPreferences:\n      type: object\n      description: Available seat filtering options\n      properties:\n        seatType:\n          type: string\n          description: Position within the row\n          enum: [window, aisle, middle]\n        side:\n          type: string\n          description: Side of the bus\n          enum: [left, right]\n        position:\n          type: string\n          description: Position in the bus\n          enum: [front, middle, back]\n        isDouble:\n          type: boolean\n          description: Whether an adjacent seat should be available\n        numbers:\n          type: array\n          description: Specific seat numbers to filter by\n          items:\n            type: number\n`

Deno.test({
  name: "actionExecutor - should create functions from OpenAPI spec",
  fn: async () => {
    const functions = await actionExecutor({
      specs,
      specType: "openapi3_yaml",
      module: "native:request",
    });
    assertEquals(typeof functions.checkRoute, "function");
  }
});

Deno.test({
  name: "actionExecutor - checkRoute should validate route between cities",
  fn: async () => {

    const fn = await actionExecutor({
      specs,
      specType: "openapi3_yaml",
      module: "native:request",
      config: {}
    });

    const session = await fn.startSession();

    console.log('session', session);

    const route = await fn.checkRoute({
      origin: "São Paulo",
      destination: "Curitiba",
      sessionId: session.sessionId,
      config: {}
    });

    console.log('route', route);

    const trips = await fn.searchTrips({
      date: "09-11-2024",
      sessionId: session.sessionId,
      preferences: {},
      config: {}
    });

    console.log('trips', trips);

    const trip = await fn.selectTrip({
      tripId: 1,
      sessionId: session.sessionId,
      config: {}
    });

    console.log('trip', trip);

    const seats = await fn.getSeats({
      sessionId: session.sessionId,
    });
    console.log('seats', seats);

    const booking = await fn.selectSeats({
      sessionId: session.sessionId,
      seats: [seats.allSeats.flat().find(seat=> !['X', 'C'].includes(seat))]
    });

    console.log('booking', booking);

    assertObjectMatch(route, {
      origin: {
        id: "-3",
        name: "SAO PAULO (TODOS) - SP",
        uf: "SP",
      },
      destination: {
        id: "-25",
        name: "CURITIBA - PR",
        uf: "PR",
      }
    });
  }
});

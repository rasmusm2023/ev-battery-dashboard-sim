import time
from fetch_chargers import get_nearby_chargers


class ElectricVehicle:
    def __init__(self, battery_level=100, lat=57.7088, lon=11.9745):
        self.battery_level = battery_level
        self.lat = lat
        self.lon = lon
        self.km_per_percent = 5.0  # 1% = 5km räckvidd
        self.total_driven_km = 0.0
        self.warned = False

    def drive(self, distance_km):
        percent_used = distance_km / self.km_per_percent
        self.battery_level = max(0, self.battery_level - percent_used)
        self.total_driven_km += distance_km

        # Simulerar lite förflyttning i koordinater
        self.lat += distance_km * 0.001
        self.lon += distance_km * 0.001

        print(
            f"Körde {distance_km}km (totalt {self.total_driven_km:.0f}km), "
            f"Batteri kvar: {self.battery_level:.1f}%"
        )

        # Mobilitetslogik: Varna om batteriet är lågt
        if self.battery_level < 20 and not self.warned:
            self.warned = True
            print("\n[VARNING] Låg batterinivå! Söker laddstationer...")
            chargers = get_nearby_chargers(self.lat, self.lon)
            print("Föreslagna laddstolpar:")
            for c in chargers:
                print(f" - {c}")


if __name__ == "__main__":
    print("Startar bilsimulering...")
    my_car = ElectricVehicle(battery_level=55)

    # Kör tills batteriet understiger 20% och varningen har visats
    while my_car.battery_level >= 20:
        my_car.drive(10)
        time.sleep(0.4)

    print("\nSimulering klar.")

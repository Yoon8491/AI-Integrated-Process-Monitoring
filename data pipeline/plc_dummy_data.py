import time
import json
import random
import math
import sys
from datetime import datetime, timedelta
from opcua import Server, ua

# ==========================================
# [1. 설정] 시뮬레이션 환경 설정
# ==========================================
CURRENT_SIM_TIME = datetime(2026, 2, 6, 0, 0, 0)
EVENT_CHANCE = 0.004  # 0.4% 확률로 데이터 이상 발생

raw_sensors = [
    {"id": "TEMP-001", "name": "주변온도센서",       "lsl": 10.5,   "usl": 35.5},
    {"id": "HUMID-001","name": "주변습도센서",       "lsl": 25.0,   "usl": 75.0},
    {"id": "PRESS-001","name": "탱크필터압력센서",    "lsl": 70.0,   "usl": 160.0},
    {"id": "PRESS-002","name": "탱크에어주입압력센서", "lsl": 3.5,    "usl": 7.5},
    {"id": "VIB-001",  "name": "CSM모터진동센서",     "lsl": 0.0,    "usl": 6.0},
    {"id": "TEMP-002", "name": "CSM모터온도센서",     "lsl": 35.0,   "usl": 85.0},
    {"id": "VIB-002",  "name": "혼합기샤프트진동센서",  "lsl": 0.0,    "usl": 6.0},
    {"id": "TEMP-003", "name": "혼합기샤프트온도센서",  "lsl": 35.0,   "usl": 75.0},
    {"id": "VIB-003",  "name": "클밀모터진동센서",     "lsl": 0.0,    "usl": 6.0},
    {"id": "TEMP-004", "name": "클밀모터온도센서",     "lsl": 45.0,   "usl": 95.0},
    {"id": "GAP-001",  "name": "클밀롤간격센서",       "lsl": 0.4,    "usl": 1.6},
    {"id": "TEMP-005", "name": "냉각수유입온도센서",    "lsl": 8.0,    "usl": 22.0},
    {"id": "TEMP-006", "name": "냉각수배출온도센서",    "lsl": 18.0,   "usl": 32.0},
    {"id": "PRESS-003","name": "충전압력센서",        "lsl": 2.5,    "usl": 6.5},
    {"id": "FLOW-001", "name": "RHK유량센서",        "lsl": 90.0,   "usl": 160.0},
    {"id": "PRESS-004","name": "RHK배기압력센서",     "lsl": -110.0, "usl": -25.0},
]

SENSORS_CONFIG = []
for s in raw_sensors:
    base = (s['usl'] + s['lsl']) / 2
    amp = (s['usl'] - s['lsl']) * 0.05
    SENSORS_CONFIG.append({
        "id": s['id'], "name": s['name'], "base": base, 
        "usl": s['usl'], "lsl": s['lsl'], "amp": amp
    })

# ==========================================
# [2. 클래스] 데이터 생산기 (핵심 로직)
# ==========================================
class SensorSimulator:
    def __init__(self, cfg):
        self.id = cfg['id']
        self.base = cfg['base']
        self.usl = cfg['usl']
        self.lsl = cfg['lsl']
        self.base_amp = cfg['amp']
        self.current_freq = 0.1
        self.tick = random.randint(0, 100)
        self.mode = "NORMAL"
        self.event_timer = 0
        self.event_target = 0

    def get_next_value(self):
        # 파형 및 노이즈 생성
        current_amp = self.base_amp + random.uniform(-self.base_amp*0.2, self.base_amp*0.2)
        self.current_freq = max(0.05, min(self.current_freq + random.uniform(-0.01, 0.01), 0.2))
        trend = self.base + (math.sin(self.tick * self.current_freq) * current_amp)
        noise = random.uniform(-(self.usl-self.lsl)*0.01, (self.usl-self.lsl)*0.01)
        final_value = trend + noise
        
        # 이상 패턴 적용 로직 (생략되었던 부분)
        if self.mode != "NORMAL":
            self.event_timer -= 1
            if self.mode == "DRIFT": final_value += self.event_target
            if self.event_timer <= 0: self.mode = "NORMAL"
        elif random.random() < EVENT_CHANCE:
            self.mode = "DRIFT"
            self.event_timer = random.randint(20, 40)
            self.event_target = (self.usl - self.lsl) * 0.5 * (1 if random.random() > 0.5 else -1)

        self.tick += 1
        return round(final_value, 2)

# ==========================================
# [3. 실행] OPC UA 서버 가동 및 루프
# ==========================================
server = Server()
server.set_endpoint("opc.tcp://0.0.0.0:4840")
server.set_server_name("Python-FDC-Simulator")

idx = server.register_namespace("http://factory.fdc.simulation")
objects = server.get_objects_node()
device_obj = objects.add_object(idx, "CSM-001")

nodes = {}
for cfg in SENSORS_CONFIG:
    node = device_obj.add_variable(ua.NodeId(cfg['id'], idx), cfg['id'], 0.0)
    node.set_writable()
    nodes[cfg['id']] = node

simulators = [SensorSimulator(cfg) for cfg in SENSORS_CONFIG]

server.start()
print("🚀 OPC UA 서버 가동 중 (opc.tcp://0.0.0.0:4840)")

try:
    while True:
        timestamp_str = CURRENT_SIM_TIME.strftime('%Y-%m-%d %H:%M:%S')
        for sim in simulators:
            val = sim.get_next_value()
            nodes[sim.id].set_value(val) # 생산된 데이터를 OPC UA에 주입
            
        if "TEMP-001" in nodes:
            print(f"[{timestamp_str}] TEMP-001: {nodes['TEMP-001'].get_value()}")
            sys.stdout.flush()

        CURRENT_SIM_TIME += timedelta(seconds=1)
        time.sleep(1)
finally:
    server.stop()
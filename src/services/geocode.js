// เรียก Google Maps Geocoding API แปลงข้อความที่อยู่เป็นพิกัด + จังหวัด
// ถ้ายังไม่ตั้ง GOOGLE_MAPS_API_KEY ระบบจะคืนค่า null แล้ว routing.js จะ fallback ไปสำนักงานใหญ่
"use strict";

const axios = require("axios");

const BKK_PATHUM_PROVINCES = ["กรุงเทพมหานคร", "กรุงเทพ", "ปทุมธานี"];

async function geocode(locationText) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.warn("[geocode] GOOGLE_MAPS_API_KEY ยังไม่ได้ตั้งค่าใน env -> ข้ามการหาพิกัด (จะ fallback ไปสำนักงานใหญ่เสมอ)");
    return null;
  }
  if (!locationText) return null;

  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: {
        address: `${locationText}, ประเทศไทย`,
        key,
        language: "th",
        region: "th",
      },
      timeout: 8000,
    });

    if (res.data && res.data.status && res.data.status !== "OK") {
      console.warn(`[geocode] Google API status ไม่ใช่ OK: ${res.data.status} สำหรับข้อความ "${locationText}" (error_message: ${res.data.error_message || "-"})`);
    }

    const result = res.data && res.data.results && res.data.results[0];
    if (!result) {
      console.warn(`[geocode] ไม่พบผลลัพธ์สำหรับข้อความ: "${locationText}"`);
      return null;
    }

    const { lat, lng } = result.geometry.location;
    const province = extractProvince(result.address_components);
    console.log(`[geocode] "${locationText}" -> province="${province}" inServiceArea=${isServiceArea(province)} formattedAddress="${result.formatted_address}"`);

    return { lat, long: lng, province, formattedAddress: result.formatted_address };
  } catch (err) {
    console.error("[geocode] error:", err.message);
    return null;
  }
}

function extractProvince(addressComponents) {
  if (!addressComponents) return null;
  const comp = addressComponents.find((c) => c.types.includes("administrative_area_level_1"));
  return comp ? comp.long_name : null;
}

function isServiceArea(province) {
  if (!province) return false;
  return BKK_PATHUM_PROVINCES.some((p) => province.includes(p));
}

// Haversine — ระยะทางเส้นตรงระหว่างจุด 2 จุด หน่วยกิโลเมตร (ไม่รวมถนนจริง แต่เพียงพอสำหรับจัดอันดับสาขาใกล้สุด)
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

module.exports = { geocode, isServiceArea, haversineKm };

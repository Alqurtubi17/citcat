import time
from playwright.sync_api import sync_playwright

def run_flash_sale():
    with sync_playwright() as p:
        # Menggunakan persistent context agar session/login tersimpan di folder profile
        # Tips: Buka manual dulu untuk login dan selesaikan CAPTCHA jika ada.
        user_data_dir = "./shopee_profile"
        
        print("[INFO] Membuka browser dengan profil tersimpan...")
        context = p.chromium.launch_persistent_context(
            user_data_dir=user_data_dir,
            headless=False,  # Harus False agar terlihat manusiawi dan tidak langsung diblokir bot detector
            args=["--disable-blink-features=AutomationControlled"] # Mengurangi deteksi navigator.webdriver
        )
        
        page = context.new_page()
        
        # Buka halaman produk Flash Sale target
        target_url = "https://shopee.co.id/product-target-link-disini"
        print(f"[INFO] Mengakses: {target_url}")
        page.goto(target_url)
        
        print("[INFO] Standby! Menunggu waktu Flash Sale...")
        
        # Contoh logika menunggu waktu atau tombol 'Beli Sekarang' aktif
        try:
            # Sesuaikan selector tombol beli di Shopee
            buy_button_selector = "button:has-text('Beli Sekarang')"
            
            # Melakukan polling cepat atau menunggu tombol bisa diklik
            page.wait_for_selector(buy_button_selector, timeout=86400000)
            print("[⚡] Tombol terdeteksi! Mengeklik...")
            page.click(buy_button_selector)
            
            print("[SUKSES] Berhasil masuk ke halaman checkout!")
            
        except Exception as e:
            print(f"[ERROR] Gagal mengeksekusi: {e}")
            
        # Jeda agar browser tidak langsung tertutup
        time.sleep(30)
        context.close()

if __name__ == "__main__":
    run_flash_sale()
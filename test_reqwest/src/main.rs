use reqwest::blocking::Client;
use std::time::Duration;

fn main() {
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(4))
        .user_agent("SmartRadioPro/13.2.0")
        .build()
        .unwrap();

    let mirrors = [
        "https://de1.api.radio-browser.info",
        "https://fr1.api.radio-browser.info",
        "https://nl1.api.radio-browser.info",
    ];
    let path = "/json/stations/bytag/top?limit=3&hidebroken=true&order=clickcount&reverse=true";

    for mirror in mirrors {
        let url = format!("{mirror}{path}");
        print!("{mirror} ... ");
        match client.get(&url).send() {
            Ok(r) => println!("OK status={}", r.status()),
            Err(e) => println!("FAIL: {e:?}\n  connect={} timeout={} status={:?}",
                e.is_connect(), e.is_timeout(), e.status()),
        }
    }
}
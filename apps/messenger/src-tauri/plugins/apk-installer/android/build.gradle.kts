plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.beyondworks.argo.messenger.apkinstaller"
    compileSdk = 36

    defaultConfig {
        minSdk = 24 // 앱 minSdk(gen/android/app/build.gradle.kts)와 같아야 매니페스트 병합이 된다. API 26 전용 호출은 Kotlin에서 Build.VERSION으로 막는다.

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")
    implementation(project(":tauri-android"))
}

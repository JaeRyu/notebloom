package io.github.jaeryu.notebloom

import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Android 15+ 는 앱을 화면 전체(상태 표시줄·내비게이션 바 아래까지)에 그리도록 강제한다.
    // WebView 는 safe-area 값을 CSS 에 알려주지 않으므로, 시스템 바·노치·키보드 영역만큼
    // 콘텐츠에 여백을 줘서 상단 바가 가려지지 않고 키보드가 열리면 화면이 줄어들게 한다.
    val content = findViewById<View>(android.R.id.content)
    // 여백(상태 표시줄 뒤 등)을 앱 배경색(styles.css 의 --bg)과 맞춘다.
    val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    content.setBackgroundColor(if (night) 0xFF191919.toInt() else 0xFFFFFFFF.toInt())
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }
}

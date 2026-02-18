import 'package:flutter_test/flutter_test.dart';

import 'package:crimson_arena/main.dart';

void main() {
  testWidgets('CrimsonArenaApp renders without errors',
      (WidgetTester tester) async {
    await tester.pumpWidget(const CrimsonArenaApp());

    // Verify the app title renders.
    expect(find.text('CRIMSON ARENA'), findsWidgets);
  });
}

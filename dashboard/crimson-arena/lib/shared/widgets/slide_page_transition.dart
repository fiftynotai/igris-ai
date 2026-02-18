import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

/// Custom slide transition for page navigation.
///
/// Slides pages from right-to-left (forward navigation) using
/// [FiftyMotion.enter] curve for a kinetic, heavy-but-fast feel.
///
/// Duration: [FiftyMotion.compiling] (300ms).
/// Direction: New page slides in from the right.
///
/// FDL rule: NO FADES. Use slides, wipes, and reveals.
class SlidePageTransition extends CustomTransition {
  @override
  Widget buildTransition(
    BuildContext context,
    Curve? curve,
    Alignment? alignment,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    return SlideTransition(
      position: Tween<Offset>(
        begin: const Offset(1.0, 0.0),
        end: Offset.zero,
      ).animate(CurvedAnimation(
        parent: animation,
        curve: FiftyMotion.enter,
      )),
      child: child,
    );
  }
}
